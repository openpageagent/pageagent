// ARP/1 adapter for the /current resource: ground-truth clock facts.
// 模型的训练记忆里没有"现在"：当前日期时间必须是可主动 GET 的一级事实源，
// 而不是只靠 runtime_context 被动注入。无权限要求、无副作用、任何入口可用。
(function attachCurrentResourceAdapter(root, factory) {
  'use strict';
  var commonJs = typeof module === 'object' && module.exports;
  var core = commonJs ? require('../protocol/index.js') : root.AgentResourceProtocol;
  if (!core) throw new Error('AgentResourceProtocol must load before current-resource-adapter.js');
  var api = factory(core);
  if (commonJs) module.exports = api;
  else root.CurrentResourceAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var NOW_SCHEMA = {
    type: 'object',
    properties: {
      epochMs: { type: 'integer' },
      iso: { type: 'string' },
      local: { type: 'string' },
      date: { type: 'string' },
      time: { type: 'string' },
      year: { type: 'integer' },
      month: { type: 'integer' },
      day: { type: 'integer' },
      weekday: { type: 'string' },
      timezoneOffsetMinutes: { type: 'integer' },
    },
    required: ['epochMs', 'iso', 'local', 'date', 'year', 'weekday'],
    additionalProperties: true,
  };

  function pad2(value) { return (value < 10 ? '0' : '') + value; }

  function nowData(clock) {
    var date = new Date(Number(clock()));
    var offsetMinutes = -date.getTimezoneOffset();
    var sign = offsetMinutes >= 0 ? '+' : '-';
    var absOffset = Math.abs(offsetMinutes);
    var weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    var dateText = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    var timeText = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    return {
      epochMs: date.getTime(),
      iso: date.toISOString(),
      local: dateText + ' ' + timeText + ' 星期' + weekdays[date.getDay()]
        + ' UTC' + sign + Math.floor(absOffset / 60) + (absOffset % 60 ? ':' + pad2(absOffset % 60) : ''),
      date: dateText,
      time: timeText,
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekday: '星期' + weekdays[date.getDay()],
      timezoneOffsetMinutes: offsetMinutes,
    };
  }

  function methodContract(summary) {
    return {
      GET: {
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: NOW_SCHEMA,
        safety: 'safe',
        idempotency: 'inherent',
        execution: 'sync',
        permissions: [],
        preconditions: [],
        relation: 'current-time',
        summary: summary,
      },
    };
  }

  function routeContracts() {
    return [
      new core.RouteContract({
        template: '/current/now',
        resourceType: 'CurrentTime',
        relation: 'current-time',
        summary: '当前本地日期和时间（权威事实；不要凭记忆猜测日期）',
        tags: ['current', 'time', 'date'],
        methods: methodContract('读取当前本地日期和时间'),
      }),
      new core.RouteContract({
        template: '/current/date',
        resourceType: 'CurrentTime',
        relation: 'current-time',
        summary: '当前本地日期（权威事实；不要凭记忆猜测日期）',
        tags: ['current', 'date'],
        methods: methodContract('读取当前本地日期'),
      }),
    ];
  }

  function createCurrentResourceAdapter(options) {
    options = options || {};
    var clock = typeof options.clock === 'function' ? options.clock : Date.now;
    function get(context, request) {
      var data = nowData(clock);
      var uri = request.routeTemplate === '/current/date' ? '/current/date' : '/current/now';
      return Promise.resolve({
        primary: {
          uri: uri,
          type: 'CurrentTime',
          data: data,
          links: [{ rel: 'self', href: uri, method: 'GET' }],
        },
        schemaValue: data,
      });
    }
    return core.defineAdapter({
      root: 'current',
      routeContracts: routeContracts(),
      get: get,
    });
  }

  return Object.freeze({
    API_VERSION: 1,
    createAdapter: createCurrentResourceAdapter,
    createCurrentResourceAdapter: createCurrentResourceAdapter,
    routeContracts: routeContracts,
  });
});
