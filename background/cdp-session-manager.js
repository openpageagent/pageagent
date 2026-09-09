// Sole owner of chrome.debugger attach/detach and per-tab CDP serialization.
(function attachCdpSessionManager(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.CdpSessionManager = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var API_VERSION = 1;

  function createCdpSessionManager(options) {
    options = options || {};
    var chromeApi = options.chrome || globalThis.chrome;
    var client = options.cdpClient;
    if (!chromeApi || !chromeApi.debugger || !client || typeof client.send !== 'function') {
      throw new Error('CdpSessionManager requires chrome.debugger and stateless CdpClient');
    }
    var states = new Map();
    var expectedDetaches = new Map();
    var expectedTabCloses = new Map();
    var detachListeners = [];
    var leaseSequence = 0;
    var detachDelayMs = Math.max(0, Number(options.detachDelayMs) || 750);

    function ensureLeaseNotAborted(signal) {
      if (!signal || signal.aborted !== true) return;
      if (signal.reason instanceof Error) throw signal.reason;
      var error = new Error('CDP lease acquisition cancelled');
      error.code = 'ACTION_CANCELLED';
      error.retryable = false;
      throw error;
    }

    function stateFor(tabId) {
      tabId = Number(tabId);
      var state = states.get(tabId);
      if (!state) {
        state = {
          tabId: tabId, status: 'detached', attachPromise: null, detachPromise: null,
          leases: new Map(), queue: Promise.resolve(), detachTimer: null, generation: 0,
          autoAttachPromise: null,
          childSessions: new Map(), frameSessions: new Map(), targetSessions: new Map(),
          retiredChildSessions: new Map(),
          reconnectPromise: null, transportEpoch: 0, childTransportEpochs: new Map(), transportWaiters: new Set(),
          activeSends: 0, detachPending: false,
          dialogPolicies: new Map(), dialogHistory: [], dialogSequence: 0,
          lifecycleEnabledPromise: null, lifecycleEvents: [], mainFrameId: '', mainLoaderId: '',
        };
        states.set(tabId, state);
      }
      return state;
    }
    function debuggee(tabId, sessionId) {
      var target = { tabId: Number(tabId) };
      if (sessionId) target.sessionId = String(sessionId);
      return target;
    }
    function attachRaw(tabId) {
      return new Promise(function (resolve, reject) {
        chromeApi.debugger.attach({ tabId: tabId }, '1.3', function () {
          var error = chromeApi.runtime && chromeApi.runtime.lastError;
          if (error) reject(error);
          else resolve();
        });
      });
    }
    function detachRaw(tabId) {
      return new Promise(function (resolve, reject) {
        tabId = Number(tabId);
        // Keep a short-lived marker so a late onDetach event from this old
        // transport cannot invalidate a connection that has already been
        // reattached. The detach callback itself is the readiness boundary;
        // callers must not wait for the event notification.
        var marker = { expiresAt: Date.now() + 30000, replaced: false };
        expectedDetaches.set(tabId, marker);
        setTimeout(function () {
          if (expectedDetaches.get(tabId) === marker) expectedDetaches.delete(tabId);
        }, 30000);
        try {
          chromeApi.debugger.detach({ tabId: tabId }, function () {
            var error = chromeApi.runtime && chromeApi.runtime.lastError;
            if (error) {
              if (expectedDetaches.get(tabId) === marker) expectedDetaches.delete(tabId);
              reject(error);
              return;
            }
            // Chrome may resolve detach() before delivering onDetach. Keep
            // the marker until that event so a new attach cannot race a stale
            // detach notification.
            resolve();
          });
        } catch (error) {
          if (expectedDetaches.get(tabId) === marker) expectedDetaches.delete(tabId);
          reject(error);
        }
      });
    }
    function rememberRetiredChildSession(state, record) {
      if (!record || !record.sessionId) return;
      var sessionId = String(record.sessionId);
      state.retiredChildSessions.set(sessionId, {
        sessionId: sessionId,
        targetId: String(record.targetId || ''),
        frameId: String(record.frameId || ''),
        parentSessionId: String(record.parentSessionId || ''),
        type: String(record.type || 'iframe'),
        url: String(record.url || ''),
      });
      while (state.retiredChildSessions.size > 200) {
        state.retiredChildSessions.delete(state.retiredChildSessions.keys().next().value);
      }
    }
    function retiredRouteForFrame(state, frameId) {
      frameId = String(frameId || '');
      if (!frameId) return null;
      var found = null;
      state.retiredChildSessions.forEach(function (record) {
        if (String(record && record.frameId || '') === frameId) found = record;
      });
      return found;
    }
    function removeChildSession(state, sessionId) {
      sessionId = String(sessionId || '');
      var record = state.childSessions.get(sessionId);
      if (!record) return false;
      rememberRetiredChildSession(state, record);
      state.childSessions.delete(sessionId);
      if (record.targetId && state.targetSessions.get(record.targetId) === sessionId) state.targetSessions.delete(record.targetId);
      state.frameSessions.forEach(function (mappedSessionId, frameId) {
        if (mappedSessionId === sessionId) state.frameSessions.delete(frameId);
      });
      return true;
    }
    function rememberFrame(state, sessionId, frameId) {
      sessionId = String(sessionId || '');
      frameId = String(frameId || '');
      var record = state.childSessions.get(sessionId);
      if (!record || !frameId) return;
      if (record.frameId && state.frameSessions.get(record.frameId) === sessionId) state.frameSessions.delete(record.frameId);
      record.frameId = frameId;
      state.frameSessions.set(frameId, sessionId);
    }
    function enableAutoAttach(state) {
      if (state.autoAttachPromise) return state.autoAttachPromise;
      var enabling = client.send(debuggee(state.tabId), 'Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      }, 30000).catch(function (error) {
        if (state.autoAttachPromise === enabling) state.autoAttachPromise = null;
        throw error;
      });
      state.autoAttachPromise = enabling;
      return enabling;
    }
    function enablePageLifecycle(state) {
      if (state.lifecycleEnabledPromise) return state.lifecycleEnabledPromise;
      // Lifecycle notifications are edge events. Enable them while the
      // transport is being acquired, before any navigation command can be
      // dispatched through the lease.
      var enabling = client.send(debuggee(state.tabId), 'Page.enable', {}, 30000).then(function () {
        return client.send(debuggee(state.tabId), 'Page.setLifecycleEventsEnabled', { enabled: true }, 30000);
      }).catch(function (error) {
        if (state.lifecycleEnabledPromise === enabling) state.lifecycleEnabledPromise = null;
        throw error;
      });
      state.lifecycleEnabledPromise = enabling;
      return enabling;
    }
    function resetLifecycleState(state) {
      state.lifecycleEnabledPromise = null;
      state.lifecycleEvents.length = 0;
      state.mainFrameId = '';
      state.mainLoaderId = '';
    }
    function attach(state) {
      if (state.attachPromise) return state.attachPromise;
      if (state.status === 'attached') return Promise.resolve(state);
      if (state.status === 'detaching' && state.detachPromise) return state.detachPromise.then(function () { return attach(state); });
      if (expectedDetaches.has(state.tabId)) {
        var marker = expectedDetaches.get(state.tabId);
        marker.replaced = true;
        state.autoAttachPromise = null;
        state.childSessions.forEach(function (record, sessionId) {
          rememberRetiredChildSession(state, Object.assign({}, record, { sessionId: sessionId }));
        });
        state.childSessions.clear();
        state.frameSessions.clear();
        state.targetSessions.clear();
        state.childTransportEpochs.clear();
        resetLifecycleState(state);
        state.transportEpoch += 1;
        notifyTransportChange(state, '');
      }
      var newlyAttached = false;
      state.status = 'attaching';
      var attaching = attachRaw(state.tabId).then(function () {
        newlyAttached = true;
        state.generation += 1;
        // Start network observation before enabling other domains. This
        // minimizes the attach-to-baseline blind gap for readiness tracking.
        return client.send(debuggee(state.tabId), 'Network.enable', {}, 30000).catch(function () {
          // Readiness will retry this domain enable on demand. Do not make an
          // otherwise usable CDP session fail to attach just because a target
          // rejected an optional network setup command.
        }).then(function () {
          return enableAutoAttach(state);
        }).then(function () {
          return enablePageLifecycle(state);
        }).then(function () {
          if (state.status === 'attaching') state.status = 'attached';
          return state;
        });
      }).catch(function (error) {
        var cleanup = newlyAttached ? detachRaw(state.tabId) : Promise.resolve();
        return cleanup.catch(function () {}).then(function () {
          if (state.attachPromise === attaching) {
            state.status = 'detached';
            state.autoAttachPromise = null;
            state.childSessions.clear();
            state.frameSessions.clear();
            state.targetSessions.clear();
            resetLifecycleState(state);
          }
          throw error;
        });
      }).finally(function () {
        if (state.attachPromise === attaching) state.attachPromise = null;
      });
      state.attachPromise = attaching;
      return attaching;
    }
    function reconnect(state) {
      if (state.reconnectPromise) return state.reconnectPromise;
      var delays = [0, 300, 1000];
      var lastError = null;
      function attempt(index) {
        var wait = delays[index] > 0
          ? new Promise(function (resolve) { setTimeout(resolve, delays[index]); })
          : Promise.resolve();
        return wait.then(function () { return attach(state); }).catch(function (error) {
          lastError = error;
          if (index + 1 >= delays.length) throw lastError;
          return attempt(index + 1);
        });
      }
      state.reconnectPromise = attempt(0).finally(function () { state.reconnectPromise = null; });
      return state.reconnectPromise;
    }
    function transportChanged(state, generation, transportEpoch, sessionId, childTransportEpoch) {
      return state.generation !== generation
        || state.status !== 'attached'
        || state.transportEpoch !== transportEpoch
        || !!sessionId && Number(state.childTransportEpochs.get(String(sessionId)) || 0) !== Number(childTransportEpoch || 0);
    }
    function notifyTransportChange(state, sessionId) {
      sessionId = String(sessionId || '');
      Array.from(state.transportWaiters).forEach(function (watcher) {
        if (!sessionId || !watcher.sessionId || watcher.sessionId === sessionId) watcher.notify();
      });
    }
    function watchTransportChange(state, generation, transportEpoch, sessionId, childTransportEpoch) {
      var active = true;
      var resolver = null;
      var promise = new Promise(function (resolve) { resolver = resolve; });
      function cancel() {
        if (!active) return;
        active = false;
        state.transportWaiters.delete(watcher);
      }
      function notify() {
        if (!active || !transportChanged(state, generation, transportEpoch, sessionId, childTransportEpoch)) return;
        cancel();
        resolver(true);
      }
      var watcher = { sessionId: String(sessionId || ''), notify: notify };
      state.transportWaiters.add(watcher);
      notify();
      return { promise: promise, cancel: cancel };
    }
    function waitForTransportEvent(state, generation, transportEpoch, sessionId, childTransportEpoch, watcher) {
      if (transportChanged(state, generation, transportEpoch, sessionId, childTransportEpoch)) return Promise.resolve(true);
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(transportChanged(state, generation, transportEpoch, sessionId, childTransportEpoch));
        }, 500);
        watcher.promise.then(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        });
      });
    }
    function waitForReplacementSession(state, frameId, targetId, fallbackSessionId) {
      if (!frameId && !targetId) return Promise.resolve(String(fallbackSessionId || ''));
      var deadline = Date.now() + 1000;
      return new Promise(function poll(resolve) {
        var replacement = targetId && state.targetSessions.get(String(targetId))
          || frameId && state.frameSessions.get(String(frameId));
        if (replacement || Date.now() >= deadline) {
          var fallback = !replacement && fallbackSessionId && state.childSessions.has(String(fallbackSessionId))
            ? String(fallbackSessionId) : '';
          resolve(String(replacement || fallback));
          return;
        }
        setTimeout(function () { poll(resolve); }, 25);
      });
    }
    function cancelDetach(state) {
      if (!state.detachTimer) return;
      clearTimeout(state.detachTimer);
      state.detachTimer = null;
    }
    function scheduleDetach(state) {
      cancelDetach(state);
      if (state.leases.size || state.status !== 'attached') return;
      if (state.activeSends > 0) {
        state.detachPending = true;
        return;
      }
      state.detachTimer = setTimeout(function () {
        state.detachTimer = null;
        if (state.leases.size || state.status !== 'attached') return;
        if (state.activeSends > 0) {
          state.detachPending = true;
          return;
        }
        state.status = 'detaching';
        state.detachPromise = detachRaw(state.tabId).then(function () {
          if (state.status === 'detaching') state.status = 'detached';
        }, function (error) {
          if (state.status === 'detaching') state.status = 'attached';
          throw error;
        }).finally(function () {
          state.detachPromise = null;
        });
        state.detachPromise.catch(function () {});
      }, detachDelayMs);
    }
    function detachIdleNow(state, options) {
      options = options || {};
      cancelDetach(state);
      if (state.leases.size || state.status === 'detached') return Promise.resolve(false);
      if (state.activeSends > 0 && options.force !== true) {
        state.detachPending = true;
        return Promise.resolve(false);
      }
      if (state.status === 'detaching' && state.detachPromise) {
        return state.detachPromise.then(function () { return true; });
      }
      if (state.status === 'attaching' && state.attachPromise) {
        return state.attachPromise.then(function () { return detachIdleNow(state); }, function () { return false; });
      }
      if (state.status !== 'attached') return Promise.resolve(false);
      state.status = 'detaching';
      state.detachPromise = detachRaw(state.tabId).then(function () {
        if (state.status === 'detaching') state.status = 'detached';
      }, function (error) {
        if (state.status === 'detaching') state.status = 'attached';
        throw error;
      }).finally(function () {
        state.detachPromise = null;
      });
      return state.detachPromise.then(function () { return true; });
    }
    function acquire(tabId, leaseOptions) {
      tabId = Math.floor(Number(tabId));
      if (!(tabId > 0)) return Promise.reject(new Error('CDP lease requires tabId'));
      var state = stateFor(tabId);
      leaseOptions = leaseOptions || {};
      var leaseSignal = leaseOptions.signal || null;
      try { ensureLeaseNotAborted(leaseSignal); } catch (error) { return Promise.reject(error); }
      cancelDetach(state);
      state.detachPending = false;
      return attach(state).then(function () {
        try {
          ensureLeaseNotAborted(leaseSignal);
        } catch (error) {
          // An aborted acquisition does not create a lease. If this call was
          // the operation that attached the tab, make the now-idle transport
          // eligible for the normal delayed detach path.
          scheduleDetach(state);
          throw error;
        }
        var leaseId = 'cdpLease_' + (++leaseSequence).toString(36) + '_' + Date.now().toString(36);
        var released = false;
        var record = {
          id: leaseId,
          type: String(leaseOptions && leaseOptions.type || 'short'),
          owner: String(leaseOptions && leaseOptions.owner || 'unknown'),
          acquiredAt: Date.now(),
        };
        async function sendDirectTo(sessionId, method, params, timeoutMs, frameHint) {
          if (released || !state.leases.has(leaseId)) return Promise.reject(new Error('CDP lease is no longer active'));
          if (state.status !== 'attached') {
            await reconnect(state);
            if (state.status !== 'attached') return sendDirectTo(sessionId, method, params, timeoutMs, frameHint);
          }
          sessionId = String(sessionId || '');
          frameHint = String(frameHint || '');
          if (!sessionId && frameHint) {
            sessionId = String(state.frameSessions.get(frameHint) || '');
            if (!sessionId) {
              var retiredFrameRoute = retiredRouteForFrame(state, frameHint);
              if (retiredFrameRoute) sessionId = retiredFrameRoute.sessionId;
            }
          }
          var routedRecord = sessionId ? state.childSessions.get(sessionId) : null;
          var retiredRoute = null;
          if (sessionId && !routedRecord) {
            retiredRoute = state.retiredChildSessions.get(sessionId) || null;
            if (retiredRoute) {
              var liveSessionId = await waitForReplacementSession(state, retiredRoute.frameId, retiredRoute.targetId, '');
              if (liveSessionId) {
                sessionId = liveSessionId;
                routedRecord = state.childSessions.get(sessionId) || null;
              }
            }
          }
          var frameId = String(routedRecord && routedRecord.frameId || retiredRoute && retiredRoute.frameId || frameHint || '');
          var targetId = String(routedRecord && routedRecord.targetId || retiredRoute && retiredRoute.targetId || '');
          var generation = state.generation;
          var transportEpoch = state.transportEpoch;
          var childTransportEpoch = Number(state.childTransportEpochs.get(String(sessionId || '')) || 0);
          var watcher = watchTransportChange(state, generation, transportEpoch, sessionId, childTransportEpoch);
          var pending;
          state.activeSends += 1;
          function sendSettled() {
            state.activeSends = Math.max(0, state.activeSends - 1);
            if (!state.activeSends && state.detachPending && !state.leases.size) {
              state.detachPending = false;
              scheduleDetach(state);
            }
          }
          try {
            pending = Promise.resolve(client.send(debuggee(tabId, sessionId), method, params || {}, timeoutMs));
          } catch (error) {
            sendSettled();
            watcher.cancel();
            throw error;
          }
          pending.then(sendSettled, sendSettled);
          var outcome = await Promise.race([
            pending.then(function (result) { return { result: result }; }, function (error) { return { error: error }; }),
            watcher.promise.then(function () { return { transportChanged: true }; }),
          ]);
          var changed = outcome.transportChanged === true;
          if (!changed && outcome.error) {
            changed = await waitForTransportEvent(state, generation, transportEpoch, sessionId, childTransportEpoch, watcher);
          }
          watcher.cancel();
          if (!changed) {
            if (outcome.error) throw outcome.error;
            return outcome.result;
          }
          pending.catch(function () {});
          // The lease may have been released while the command was in flight
          // (for example, an explicit tab close). Do not resurrect that tab.
          if (released || !state.leases.has(leaseId)) {
            if (outcome.error) throw outcome.error;
            return pending;
          }
          if (state.status !== 'attached') {
            await reconnect(state);
            if (state.status !== 'attached') return sendDirectTo(sessionId, method, params, timeoutMs, frameHint);
          }
          var retrySessionId = sessionId
            ? await waitForReplacementSession(state, frameId, targetId, sessionId)
            : '';
          if (sessionId && !retrySessionId) {
            if (outcome.error) throw outcome.error;
            return pending;
          }
          return sendDirectTo(retrySessionId, method, params, timeoutMs, frameHint || frameId);
        }
        function ensureFrameRoute(record) {
          if (!record || state.childSessions.get(record.sessionId) !== record) return Promise.resolve(null);
          if (record.frameReadyPromise) return record.frameReadyPromise;
          var pending = Promise.resolve().then(function () {
            return sendDirect.forSession(record.sessionId)('Page.getFrameTree', {}, 10000);
          }).then(function (response) {
            if (state.childSessions.get(record.sessionId) === record) {
              var frameTree = response && response.frameTree && response.frameTree.frame;
              if (frameTree && frameTree.id) rememberFrame(state, record.sessionId, frameTree.id);
              else record.frameReadyPromise = null;
            }
            return record;
          }).catch(function (error) {
            if (state.childSessions.get(record.sessionId) !== record) return null;
            // A frame can be between attach and document creation. Do not
            // retain a rejected route probe: the next live CDP read must be
            // able to establish the route again.
            record.frameReadyPromise = null;
            throw error;
          });
          record.frameReadyPromise = pending;
          return pending;
        }
        function routeRecord(sessionId) {
          if (!sessionId) return { tabId: tabId, sessionId: '', frameId: '', parentSessionId: '', root: true };
          var record = state.childSessions.get(String(sessionId));
          return record ? {
            tabId: tabId, sessionId: record.sessionId, targetId: record.targetId,
            frameId: record.frameId, parentSessionId: record.parentSessionId,
            type: record.type, url: record.url, root: false,
          } : null;
        }
        function createSender(sessionId, dynamicFrameId) {
          sessionId = String(sessionId || '');
          dynamicFrameId = String(dynamicFrameId || '');
          function currentSessionId() {
            return dynamicFrameId ? String(state.frameSessions.get(dynamicFrameId) || '') : sessionId;
          }
          function sender(method, params, timeoutMs) {
            return sendDirectTo(currentSessionId(), method, params, timeoutMs, dynamicFrameId);
          }
          sender.forSession = function (childSessionId) { return createSender(childSessionId, ''); };
          sender.forFrame = function (frameId) {
            return createSender('', String(frameId || ''));
          };
          sender.getFrameRoute = function (frameId) {
            var childSessionId = state.frameSessions.get(String(frameId || ''));
            return childSessionId ? routeRecord(childSessionId) : null;
          };
          sender.getSessionRoute = function (childSessionId) { return routeRecord(childSessionId); };
          sender.listFrameRoutes = function () {
            return Array.from(state.childSessions.values()).filter(function (child) {
              return child.type === 'iframe' && !!child.frameId;
            }).map(function (child) { return routeRecord(child.sessionId); });
          };
          sender.waitForFrameRoutes = function () {
            var records = Array.from(state.childSessions.values()).filter(function (child) {
              return child.type === 'iframe';
            });
            return Promise.all(records.map(ensureFrameRoute)).then(function () { return sender.listFrameRoutes(); });
          };
          return sender;
        }
        var sendDirect = createSender('');
        function release() {
          if (released) return Promise.resolve(false);
          released = true;
          state.leases.delete(leaseId);
          scheduleDetach(state);
          return Promise.resolve(true);
        }
        record.release = release;
        record.sendDirect = sendDirect;
        state.leases.set(leaseId, record);
        return Object.freeze({
          id: leaseId,
          tabId: tabId,
          generation: state.generation,
          send: function (method, params, timeoutMs) {
            return enqueue(tabId, function () { return sendDirect(method, params, timeoutMs); });
          },
          sendForFrame: function (frameId, method, params, timeoutMs) {
            return enqueue(tabId, function () { return sendDirect.forFrame(frameId)(method, params, timeoutMs); });
          },
          // JavaScript dialogs block the page command that opened them. This
          // manager-owned priority path is intentionally limited to the one
          // protocol command that must break that dependency cycle.
          sendUrgent: function (method, params, timeoutMs) {
            if (method !== 'Page.handleJavaScriptDialog') return Promise.reject(new Error('Only Page.handleJavaScriptDialog may use urgent delivery'));
            return sendDirect(method, params, timeoutMs);
          },
          sendUrgentForSession: function (sessionId, method, params, timeoutMs) {
            if (method !== 'Page.handleJavaScriptDialog') return Promise.reject(new Error('Only Page.handleJavaScriptDialog may use urgent delivery'));
            return sendDirect.forSession(sessionId)(method, params, timeoutMs);
          },
          listFrameRoutes: function () { return sendDirect.listFrameRoutes(); },
          release: release,
        });
      });
    }
    function enqueue(tabId, task) {
      var state = stateFor(tabId);
      var running = state.queue.catch(function () {}).then(function () {
        return task();
      });
      state.queue = running.catch(function () {});
      return running;
    }
    function withLease(tabId, leaseOptions, task) {
      leaseOptions = Object.assign({}, leaseOptions || {});
      var leaseSignal = leaseOptions.signal || null;
      return acquire(tabId, leaseOptions).then(function (lease) {
        return enqueue(tabId, function () {
          ensureLeaseNotAborted(leaseSignal);
          var state = stateFor(tabId);
          var record = state.leases.get(lease.id);
          if (!record) throw new Error('CDP lease is no longer active');
          return task(record.sendDirect, lease);
        }).then(function (result) {
          return lease.release().then(function () { return result; });
        }, function (error) {
          return lease.release().then(function () { throw error; });
        });
      });
    }
    function removeDialogPolicy(state, policy, releaseLease) {
      if (!policy) return Promise.resolve(false);
      if (state.dialogPolicies.get(policy.id) === policy) state.dialogPolicies.delete(policy.id);
      if (policy.timer) clearTimeout(policy.timer);
      policy.timer = null;
      if (releaseLease !== false && policy.lease && typeof policy.lease.release === 'function') {
        var lease = policy.lease;
        policy.lease = null;
        return lease.release().then(function () { return true; });
      }
      policy.lease = null;
      return Promise.resolve(true);
    }
    function installDialogPolicy(tabId, policyOptions) {
      tabId = Math.floor(Number(tabId));
      policyOptions = policyOptions || {};
      var state = stateFor(tabId);
      var owner = String(policyOptions.owner || '');
      if (!(tabId > 0)) return Promise.reject(new Error('Dialog policy requires tabId'));
      if (!owner) return Promise.reject(new Error('Dialog policy requires owner'));
      var existing = Array.from(state.dialogPolicies.values()).filter(function (policy) { return policy.owner === owner; });
      return Promise.all(existing.map(function (policy) { return removeDialogPolicy(state, policy, true); })).then(function () {
        return acquire(tabId, { owner: 'DialogPolicy:' + owner, type: 'dialog-policy' });
      }).then(function (lease) {
        return lease.send('Page.enable', {}, 10000).then(function () {
          var configuredTimeoutMs = Number(policyOptions.timeoutMs);
          var timeoutMs = configuredTimeoutMs > 0 ? Math.max(100, Math.min(configuredTimeoutMs, 120000)) : 0;
          var installedAtMs = Date.now();
          var policy = {
            id: 'dialogPolicy_' + (++state.dialogSequence).toString(36) + '_' + installedAtMs.toString(36),
            owner: owner,
            action: String(policyOptions.action || 'accept').toLowerCase() === 'dismiss' ? 'dismiss' : 'accept',
            promptText: String(policyOptions.promptText || ''),
            installedAt: new Date(installedAtMs).toISOString(),
            installedAtMs: installedAtMs,
            expiresAt: timeoutMs ? new Date(installedAtMs + timeoutMs).toISOString() : '',
            expiresAtMs: timeoutMs ? installedAtMs + timeoutMs : Number.POSITIVE_INFINITY,
            lease: lease,
            timer: null,
          };
          if (timeoutMs) policy.timer = setTimeout(function () { removeDialogPolicy(state, policy, true).catch(function () {}); }, timeoutMs);
          state.dialogPolicies.set(policy.id, policy);
          return { id: policy.id, owner: owner, action: policy.action, installedAt: policy.installedAt, expiresAt: policy.expiresAt };
        }, function (error) {
          return lease.release().then(function () { throw error; });
        });
      });
    }
    function readDialogHistory(tabId, limit) {
      var state = states.get(Number(tabId));
      var maximum = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 20));
      if (!state) return [];
      return state.dialogHistory.slice(-maximum).map(function (dialog) {
        return JSON.parse(JSON.stringify(dialog));
      });
    }
    function noDialogShowing(error) {
      return /(?:no (?:javascript )?dialog (?:is )?(?:showing|open|available|to handle)|dialog (?:is )?not (?:showing|open|available))/i.test(String(error && error.message || error));
    }
    function handleOrInstallDialogPolicy(tabId, policyOptions) {
      tabId = Math.floor(Number(tabId));
      policyOptions = policyOptions || {};
      var action = String(policyOptions.action || 'accept').toLowerCase() === 'dismiss' ? 'dismiss' : 'accept';
      var dialogParams = { accept: action !== 'dismiss', promptText: String(policyOptions.promptText || '') };
      return acquire(tabId, { owner: 'DialogImmediate:' + String(policyOptions.owner || 'unknown'), type: 'dialog' }).then(function (lease) {
        var requestedAtMs = Date.now();
        return lease.sendUrgent('Page.handleJavaScriptDialog', dialogParams, 5000).then(function () {
          var handledAt = new Date().toISOString();
          var state = stateFor(tabId);
          var dialog = state.dialogHistory.slice().reverse().find(function (candidate) {
            var closedAtMs = Date.parse(String(candidate.closedAt || ''));
            return candidate.handled !== true && candidate.openedAt
              && (!Number.isFinite(closedAtMs) || closedAtMs >= requestedAtMs);
          });
          if (dialog) {
            dialog.handled = true;
            dialog.action = action;
            dialog.handledAt = handledAt;
          } else {
            state.dialogHistory.push({
              id: 'dialog_' + (++state.dialogSequence).toString(36) + '_' + Date.now().toString(36),
              type: '', message: '', url: '', openedAt: '', handled: true, action: action, handledAt: handledAt,
            });
            if (state.dialogHistory.length > 20) state.dialogHistory.splice(0, state.dialogHistory.length - 20);
          }
          return lease.release().then(function () {
            return { armed: false, handled: true, action: action, handledAt: handledAt, sessionId: '' };
          });
        }, function (error) {
          return lease.release().then(function () {
            if (!noDialogShowing(error)) throw error;
            return installDialogPolicy(tabId, Object.assign({}, policyOptions, { action: action })).then(function (policy) {
              return { armed: true, handled: false, action: action, installedAt: policy.installedAt, expiresAt: policy.expiresAt, sessionId: '' };
            });
          });
        });
      });
    }
    function retainOwnerLease(tabId, leaseOptions) {
      tabId = Math.floor(Number(tabId));
      leaseOptions = leaseOptions || {};
      var owner = String(leaseOptions.owner || '');
      var type = String(leaseOptions.type || 'retained');
      var leaseSignal = leaseOptions.signal || null;
      if (!(tabId > 0)) return Promise.reject(new Error('Retained CDP lease requires tabId'));
      if (!owner) return Promise.reject(new Error('Retained CDP lease requires owner'));
      try { ensureLeaseNotAborted(leaseSignal); } catch (error) { return Promise.reject(error); }
      return enqueue(tabId, function () {
        ensureLeaseNotAborted(leaseSignal);
        var state = stateFor(tabId);
        var retained = Array.from(state.leases.values()).some(function (lease) {
          return lease.owner === owner && lease.type === type;
        });
        if (retained) {
          cancelDetach(state);
          return false;
        }
        return acquire(tabId, {
          owner: owner, type: type, timeoutMs: leaseOptions.timeoutMs, signal: leaseSignal,
        }).then(function (lease) {
          if (!leaseSignal || leaseSignal.aborted !== true) return true;
          return lease.release().then(function () {
            ensureLeaseNotAborted(leaseSignal);
            return true;
          });
        });
      });
    }
    function releaseOwner(owner, releaseOptions) {
      owner = String(owner || '');
      releaseOptions = releaseOptions || {};
      var releases = [];
      var touchedStates = [];
      states.forEach(function (state) {
        var touched = false;
        Array.from(state.dialogPolicies.values()).forEach(function (policy) {
          if (!owner || policy.owner === owner || policy.owner.endsWith(':' + owner)) {
            releases.push(removeDialogPolicy(state, policy, true));
            touched = true;
          }
        });
        Array.from(state.leases.entries()).forEach(function (entry) {
          if (!owner || entry[1].owner === owner || entry[1].owner.endsWith(':' + owner)) {
            releases.push(entry[1].release());
            touched = true;
          }
        });
        if (touched) touchedStates.push(state);
      });
      return Promise.all(releases).then(function () {
        if (releaseOptions.detachImmediately !== true) return releases.length;
        return Promise.all(touchedStates.map(function (state) {
          return detachIdleNow(state, { force: true });
        })).then(function () { return releases.length; });
      });
    }
    function releaseTab(tabId, releaseOptions) {
      tabId = Math.floor(Number(tabId));
      releaseOptions = releaseOptions || {};
      var state = states.get(tabId);
      if (!state) return Promise.resolve(0);
      Array.from(state.dialogPolicies.values()).forEach(function (policy) { removeDialogPolicy(state, policy, false); });
      var releases = Array.from(state.leases.values()).map(function (lease) {
        return lease.release();
      });
      return Promise.all(releases).then(function () {
        if (releaseOptions.detachImmediately !== true) return releases.length;
        return detachIdleNow(state, { force: true }).then(function () { return releases.length; });
      });
    }
    function closeTab(tabId, closeOptions) {
      closeOptions = closeOptions || {};
      tabId = Number(tabId);
      if (closeOptions.expectTabRemoval === true) {
        var marker = { expiresAt: Date.now() + 30000, owner: String(closeOptions.owner || '') };
        expectedTabCloses.set(tabId, marker);
        setTimeout(function () {
          if (expectedTabCloses.get(tabId) === marker) expectedTabCloses.delete(tabId);
        }, 30000);
      }
      var state = states.get(tabId);
      if (!state) return Promise.resolve();
      cancelDetach(state);
      Array.from(state.dialogPolicies.values()).forEach(function (policy) { removeDialogPolicy(state, policy, false); });
      state.leases.clear();
      state.childSessions.clear();
      state.frameSessions.clear();
      state.targetSessions.clear();
      state.retiredChildSessions.clear();
      resetLifecycleState(state);
      function removeState() {
        if (states.get(tabId) === state) states.delete(tabId);
      }
      function detachAttached() {
        if (state.status !== 'attached') {
          removeState();
          return Promise.resolve();
        }
        state.status = 'detaching';
        return detachRaw(tabId).then(function () {
          state.status = 'detached';
          removeState();
        }, function (error) {
          if (state.status === 'detaching') state.status = 'attached';
          removeState();
          throw error;
        });
      }
      if (state.status === 'attaching' && state.attachPromise) {
        return state.attachPromise.then(detachAttached, function (error) {
          removeState();
          throw error;
        });
      }
      if (state.status === 'detaching' && state.detachPromise) {
        return state.detachPromise.then(removeState, function (error) {
          removeState();
          throw error;
        });
      }
      return detachAttached();
    }
    function consumeExpectedTabClose(tabId) {
      tabId = Number(tabId);
      var marker = expectedTabCloses.get(tabId);
      var expected = marker && Number(marker.expiresAt) >= Date.now() ? marker : null;
      expectedTabCloses.delete(tabId);
      return expected;
    }
    function cancelExpectedTabClose(tabId) {
      return expectedTabCloses.delete(Number(tabId));
    }
    function onDetach(listener) {
      if (typeof listener !== 'function') return function () {};
      detachListeners.push(listener);
      return function () { var index = detachListeners.indexOf(listener); if (index !== -1) detachListeners.splice(index, 1); };
    }
    function recordLifecycleEvent(state, event) {
      event = event || {};
      var frameId = String(event.frameId || state.mainFrameId || '');
      var loaderId = String(event.loaderId || (frameId && frameId === state.mainFrameId ? state.mainLoaderId : '') || '');
      if (!frameId || !loaderId) return;
      state.lifecycleEvents.push({
        source: String(event.source || ''),
        name: String(event.name || ''),
        frameId: frameId,
        loaderId: loaderId,
        at: Date.now(),
      });
      if (state.lifecycleEvents.length > 200) state.lifecycleEvents.splice(0, state.lifecycleEvents.length - 200);
    }
    function getLoadEvidence(tabId, options) {
      var state = states.get(Number(tabId));
      if (!state) return null;
      options = options || {};
      var frameId = String(options.frameId || state.mainFrameId || '');
      var loaderId = String(options.loaderId || '');
      var previousLoaderId = String(options.previousLoaderId || '');
      var afterMs = Math.max(0, Number(options.afterMs) || 0);
      var eventNames = Array.isArray(options.eventNames) && options.eventNames.length
        ? options.eventNames.map(String)
        : ['load'];
      var events = state.lifecycleEvents.filter(function (event) {
        if (frameId && event.frameId !== frameId) return false;
        if (loaderId && event.loaderId !== loaderId) return false;
        if (!loaderId && previousLoaderId && event.loaderId === previousLoaderId) return false;
        if (afterMs && Number(event.at) < afterMs) return false;
        // Page.loadEventFired and Page.frameStoppedLoading carry no loaderId;
        // attributing either edge to the current loader can let a late event
        // from the previous document satisfy a new-document wait. The
        // loader-bound Page.lifecycleEvent is the strict CDP evidence.
        return event.source === 'Page.lifecycleEvent' && eventNames.indexOf(event.name) !== -1;
      });
      var event = events.length ? events[events.length - 1] : null;
      return event ? JSON.parse(JSON.stringify({
        source: event.source,
        name: event.name,
        frameId: event.frameId,
        loaderId: event.loaderId,
        at: event.at,
      })) : null;
    }
    chromeApi.debugger.onDetach.addListener(function (source, reason) {
      var tabId = Number(source && source.tabId);
      if (!(tabId > 0)) return;
      var expected = expectedDetaches.get(tabId);
      var replaced = !!(expected && expected.replaced === true);
      expectedDetaches.delete(tabId);
      // This is the delayed notification for a detach that has already been
      // followed by a new attach. It must not tear down the new transport.
      if (replaced) return;
      var state = states.get(tabId);
      if (!state) return;
      var managed = !!expected || state.status === 'detaching';
      cancelDetach(state);
      state.status = 'detached';
      state.generation += 1;
      state.autoAttachPromise = null;
      state.childSessions.forEach(function (record, sessionId) {
        rememberRetiredChildSession(state, Object.assign({}, record, { sessionId: sessionId }));
      });
      state.childSessions.clear();
      state.frameSessions.clear();
      state.targetSessions.clear();
      state.childTransportEpochs.clear();
      resetLifecycleState(state);
      state.transportEpoch += 1;
      notifyTransportChange(state, '');
      if (!managed && state.leases.size) reconnect(state).catch(function () {});
      detachListeners.slice().forEach(function (listener) { try { listener({ tabId: tabId, reason: reason || 'detached', managed: managed }); } catch (_) {} });
    });
    chromeApi.debugger.onEvent.addListener(function (source, method, params) {
      var tabId = Number(source && source.tabId);
      if (!(tabId > 0)) return;
      var state = states.get(tabId);
      if (!state) return;
      params = params || {};
      if (method === 'Target.attachedToTarget') {
        var sessionId = String(params.sessionId || '');
        var targetInfo = params.targetInfo || {};
        if (!sessionId) return;
        if (String(targetInfo.type || '') !== 'iframe') return;
        var previousSessionId = state.targetSessions.get(String(targetInfo.targetId || ''));
        if (previousSessionId && previousSessionId !== sessionId) {
          removeChildSession(state, previousSessionId);
          state.childTransportEpochs.set(previousSessionId, Number(state.childTransportEpochs.get(previousSessionId) || 0) + 1);
          notifyTransportChange(state, previousSessionId);
        }
        var record = {
          sessionId: sessionId,
          parentSessionId: String(source.sessionId || ''),
          targetId: String(targetInfo.targetId || ''),
          frameId: '',
          type: String(targetInfo.type || ''), url: String(targetInfo.url || ''),
        };
        state.childSessions.set(sessionId, record);
        if (record.targetId) state.targetSessions.set(record.targetId, sessionId);
        if (record.frameId) state.frameSessions.set(record.frameId, sessionId);
        // OOPIF traffic is delivered through its child session. Enable the
        // Network domain as soon as that session appears so a readiness
        // baseline can account for requests already in flight in the frame.
        client.send(debuggee(state.tabId, sessionId), 'Network.enable', {}, 30000).catch(function () {});
        return;
      }
      if (method === 'Target.detachedFromTarget') {
        var detachedSessionId = String(params.sessionId || state.targetSessions.get(String(params.targetId || '')) || '');
        if (!detachedSessionId) return;
        removeChildSession(state, detachedSessionId);
        state.childTransportEpochs.set(detachedSessionId, Number(state.childTransportEpochs.get(detachedSessionId) || 0) + 1);
        notifyTransportChange(state, detachedSessionId);
        return;
      }
      if (source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
        rememberFrame(state, source.sessionId, params.frame.id);
        return;
      }
      if (!source.sessionId && method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
        state.mainFrameId = String(params.frame.id || '');
        // Same-document frameNavigated notifications may omit loaderId. Keep
        // the current loader identity in that case; clearing it would make a
        // still-valid load event impossible to associate with this document.
        if (params.frame.loaderId) state.mainLoaderId = String(params.frame.loaderId);
        return;
      }
      if (source.sessionId && method === 'Runtime.executionContextCreated') {
        var auxData = params.context && params.context.auxData || {};
        if (auxData.frameId && auxData.isDefault === true) rememberFrame(state, source.sessionId, auxData.frameId);
        return;
      }
      if (!source.sessionId && method === 'Page.lifecycleEvent') {
        var lifecycleFrame = String(params.frameId || state.mainFrameId || '');
        var lifecycleLoader = String(params.loaderId || (lifecycleFrame === state.mainFrameId ? state.mainLoaderId : '') || '');
        // Lifecycle notifications are edge events and an older loader can be
        // delivered after a newer Page.frameNavigated event. Once the main
        // frame has a known current loader, never let that stale event replace
        // the current identity or become load evidence for the new document.
        if (lifecycleFrame === state.mainFrameId && state.mainLoaderId && lifecycleLoader
            && lifecycleLoader !== state.mainLoaderId) return;
        if (lifecycleFrame && lifecycleLoader) {
          if (lifecycleFrame === state.mainFrameId) state.mainLoaderId = lifecycleLoader;
          recordLifecycleEvent(state, {
            source: 'Page.lifecycleEvent', name: String(params.name || ''),
            frameId: lifecycleFrame, loaderId: lifecycleLoader,
          });
        }
        return;
      }
      if (!source.sessionId && method === 'Page.loadEventFired') {
        recordLifecycleEvent(state, {
          source: 'Page.loadEventFired', name: 'loadEventFired',
          frameId: state.mainFrameId, loaderId: state.mainLoaderId,
        });
        return;
      }
      if (!source.sessionId && method === 'Page.frameStoppedLoading') {
        var stoppedFrame = String(params.frameId || '');
        recordLifecycleEvent(state, {
          source: 'Page.frameStoppedLoading', name: 'frameStoppedLoading',
          frameId: stoppedFrame, loaderId: stoppedFrame === state.mainFrameId ? state.mainLoaderId : '',
        });
        return;
      }
      if (method === 'Page.javascriptDialogOpening') {
        var openedAtMs = Date.now();
        var dialog = {
          id: 'dialog_' + (++state.dialogSequence).toString(36) + '_' + openedAtMs.toString(36),
          type: String(params.type || ''), message: String(params.message || ''), url: String(params.url || ''),
          defaultPrompt: String(params.defaultPrompt || ''), hasBrowserHandler: params.hasBrowserHandler === true,
          openedAt: new Date(openedAtMs).toISOString(), handled: false,
        };
        state.dialogHistory.push(dialog);
        if (state.dialogHistory.length > 20) state.dialogHistory.splice(0, state.dialogHistory.length - 20);
        var policy = Array.from(state.dialogPolicies.values()).filter(function (candidate) {
          return candidate.expiresAtMs >= openedAtMs;
        }).sort(function (left, right) { return right.installedAtMs - left.installedAtMs; })[0] || null;
        if (!policy) return;
        var paramsForDialog = { accept: policy.action !== 'dismiss', promptText: policy.promptText };
        policy.lease.sendUrgentForSession(String(source && source.sessionId || ''), 'Page.handleJavaScriptDialog', paramsForDialog, 5000).then(function () {
          dialog.handled = true;
          dialog.action = policy.action;
          dialog.handledAt = new Date().toISOString();
          removeDialogPolicy(state, policy, true).catch(function () {});
        }, function (error) {
          dialog.error = String(error && error.message || error);
          removeDialogPolicy(state, policy, true).catch(function () {});
        });
        return;
      }
      if (method === 'Page.javascriptDialogClosed') {
        for (var dialogIndex = state.dialogHistory.length - 1; dialogIndex >= 0; dialogIndex -= 1) {
          var openDialog = state.dialogHistory[dialogIndex];
          if (openDialog.closedAt) continue;
          openDialog.closedAt = new Date().toISOString();
          openDialog.result = params.result === true;
          openDialog.userInput = String(params.userInput || '');
          break;
        }
      }
    });
    return Object.freeze({
      acquire: acquire,
      enqueue: enqueue,
      withLease: withLease,
      retainOwnerLease: retainOwnerLease,
      releaseOwner: releaseOwner,
      releaseTab: releaseTab,
      installDialogPolicy: installDialogPolicy,
      handleOrInstallDialogPolicy: handleOrInstallDialogPolicy,
      readDialogHistory: readDialogHistory,
      closeTab: closeTab,
      consumeExpectedTabClose: consumeExpectedTabClose,
      cancelExpectedTabClose: cancelExpectedTabClose,
      onDetach: onDetach,
      getLoadEvidence: getLoadEvidence,
      getState: function (tabId) {
        var state = states.get(Number(tabId));
        return state ? { tabId: state.tabId, status: state.status, leaseCount: state.leases.size, generation: state.generation, childSessionCount: state.childSessions.size, frameRouteCount: state.frameSessions.size } : null;
      },
    });
  }
  return Object.freeze({ API_VERSION: API_VERSION, createCdpSessionManager: createCdpSessionManager });
});
