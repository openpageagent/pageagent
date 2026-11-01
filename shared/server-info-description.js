// Shared facts for the connection UI and model context. Values remain text, never HTML.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ServerInfoDescription = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function present(value) { return value !== null && value !== undefined && value !== ''; }
  function boolean(value, yes, no) { return value === true ? yes : value === false ? no : ''; }
  function bytes(value) {
    if (!present(value)) return '';
    var size = Number(value), index = 0;
    if (!Number.isFinite(size) || size < 0) return String(value);
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return (index ? size.toFixed(2).replace(/\.?0+$/, '') : String(value)) + ' ' + units[index];
  }
  function duration(value) {
    if (!present(value)) return '';
    var units = [[86400000, '天'], [3600000, '小时'], [60000, '分钟'], [1000, '秒']];
    for (var index = 0; index < units.length; index += 1) {
      if (value >= units[index][0] && value % units[index][0] === 0) return value / units[index][0] + ' ' + units[index][1];
    }
    return value >= 1000 ? value / 1000 + ' 秒' : value + ' 毫秒';
  }
  function time(value) {
    if (!present(value)) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  }
  function reason(value) {
    return { SAMPLE_FAILED: '采样失败', SAMPLE_TIMEOUT: '采样超时', ENVIRONMENT_CHANGED: '环境已变化',
      CONSTRAINTS_NOT_DETECTED: '未检测配额和只读状态' }[value] || value || '';
  }
  function paragraph(output, sentences) {
    var parts = [];
    sentences.forEach(function (fields) {
      var start = parts.length;
      fields.forEach(function (field) {
        if (!present(field[1])) return;
        parts.push({ text: (parts.length > start ? '，' : '') + (field[0] ? field[0] + ' ' : '') });
        parts.push({ text: String(field[1]), strong: true });
        if (field[2]) parts.push({ text: field[2] });
      });
      if (parts.length > start) parts.push({ text: '。' });
    });
    if (parts.length) output.push(parts);
  }

  // Related clauses form sentences; related sentences form paragraphs.
  var executionParagraphs = [
    [
      [
        ['bashDefaultTimeoutMs', '命令默认限时'], ['bashMaxTimeoutMs', '最长可设'], ['outputBytes', '输出最多保留']
      ],
      [
        ['readBytes', '单次文件读取不超过'], ['writeBytes', '写入不超过'], ['fileTimeoutMs', '文件操作限时'], ['grepEntries', '搜索最多访问', ' 个文件或目录条目']
      ],
      [
        ['desktopTimeoutMs', '桌面操作限时'], ['desktopOutputBytes', '桌面输出最多保留'], ['desktopErrorBytes', '错误输出最多保留']
      ],
      [
        ['imageBytes', '单张图片大小不超过'], ['imagePixels', '像素总数不超过']
      ]
    ],
    [
      [
        ['connections', '最多允许', ' 个连接'], ['workspaces', '每个连接最多配置', ' 个目录'], ['unauthenticated', '未认证连接最多', ' 个']
      ],
      [
        ['clientActive', '单客户端最多', ' 个并发请求'], ['serverActive', '服务端合计最多', ' 个并发请求'], ['frameBytes', '单帧数据不超过']
      ],
      [
        ['authBytes', '认证消息不超过'], ['authTimeoutMs', '认证限时'],
        ['configureBytes', '目录配置消息不超过'], ['configureTimeoutMs', '配置限时']
      ]
    ],
    [
      [
        ['httpSessions', 'HTTP 最多保留', ' 个会话'], ['httpSessionActive', '每个会话最多', ' 个并发请求'], ['httpActive', 'HTTP 总并发不超过']
      ],
      [
        ['httpBodyBytes', 'HTTP 请求体不超过'], ['httpIdleMs', '会话允许空闲']
      ]
    ],
    [
      [
        ['cancelAck', '', '取消确认'], ['processTermination', '进程终止范围'], ['stopWaitMs', '停止确认最多等待'], ['clientWaitMs', '客户端最多等待']
      ],
      [
        ['cpuHardLimit', '', ' CPU 硬限制'], ['memoryHardLimit', '', '内存硬限制']
      ],
      [
        ['seenRequests', '最多保留', ' 条已见请求记录'], ['settledCount', '完成记录最多', ' 条'], ['settledTtlMs', '完成记录保留']
      ]
    ]
  ];
  var samplingFields = [
    ['sampleTimeoutMs', '环境采样限时'], ['dynamicTtlMs', '动态采样有效'], ['sampleIntervalMs', '两次采样至少间隔']
  ];
  var auditSentences = [
    [
      ['auditRecordBytes', '单条审计记录不超过'], ['auditQueueCount', '队列最多容纳', ' 条记录'], ['auditQueueBytes', '队列总容量不超过']
    ],
    [
      ['auditWaitMs', '审计写入最多等待'], ['auditRecoverMs', '恢复间隔']
    ],
    [
      ['auditRotateBytes', '审计文件按', ' 阈值轮转'], ['auditTotalBytes', '文件总容量不超过'], ['auditRetainMs', '记录保留']
    ]
  ];
  function executionValue(key, value) {
    if (!present(value)) return '';
    if (key === 'processTermination') return { 'posix-process-group': 'POSIX 进程组', 'windows-taskkill-tree': 'Windows 进程树',
      'windows-child-only': '仅 Windows 子进程' }[value] || String(value);
    if (typeof value === 'boolean') return boolean(value, '支持', '不支持');
    if (key.endsWith('Bytes')) return bytes(value);
    if (key.endsWith('Ms')) return duration(value);
    return (typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value)) + (key === 'imagePixels' ? ' 像素' : '');
  }
  function environment(connection, result) {
    connection = connection || {};
    var snapshot = result ? result.environment : connection.environment;
    var memory = result ? result.memory : connection.observations && connection.observations.memory;
    var capabilities = connection.capabilities || {}, output = [];
    var execution = capabilities.execution || {}, remaining = new Set(Object.keys(execution));
    function executionFields(fields) {
      return fields.map(function (field) {
        remaining.delete(field[0]);
        return [field[1], executionValue(field[0], execution[field[0]]), field[2]];
      });
    }
    if (snapshot) {
      var os = snapshot.os || {}, distribution = os.distribution || {}, runtime = snapshot.runtime || {};
      var cpu = snapshot.cpu || {}, executor = snapshot.executor || {}, shell = snapshot.shell;
      paragraph(output, [
        [
          ['服务端运行在', distribution.name || { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[os.platform] || os.platform],
          ['采用', runtime.arch, ' 架构'], ['使用 Node.js', runtime.nodeVersion],
          [shell ? '命令通过' : '', shell ? shell.executable : '未检测到 Bash', shell ? ' 执行' : '']
        ],
        [
          ['系统平台', os.platform], ['发行版本', distribution.version], ['内核', os.kernelRelease], ['系统版本', os.version]
        ],
        [
          ['以', executor.user, ' 身份运行'], ['用户 ID', executor.uid], ['用户组 ID', executor.gid], ['路径遵循', runtime.pathStyle, ' 格式']
        ]
      ]);
      paragraph(output, [
        [
          ['共有', cpu.logicalCount, ' 个逻辑线程'], ['可用并行数', cpu.availableParallelism]
        ],
        [
          ['内存共', bytes(snapshot.memory && snapshot.memory.totalBytes)], ['空闲', bytes(memory && memory.freeBytes)],
          ['当前进程可用', bytes(memory && memory.processAvailableBytes)], ['进程内存约束', bytes(memory && memory.processConstraintBytes)]
        ],
        [
          ['内存采样于', time(memory && memory.observedAt)], ['有效至', time(memory && memory.expiresAt)],
          ['当前采样', memory && (memory.status === 'unavailable' ? '不可用' : memory.stale ? '来自历史记录'
            : memory.status === 'partial' ? '部分可用' : '')], ['内存采样异常：', reason(memory && memory.reason)]
        ]
      ]);
    } else output.push([{ text: connection.ready === false ? '连接未就绪，尚无环境信息。' : '服务端未提供环境信息。' }]);
    paragraph(output, [
      [
        ['环境采样于', time(snapshot && snapshot.observedAt)],
        ['环境信息', snapshot && (connection.ready === false ? '来自上次连接' : snapshot.stale ? '已过期' : '')],
        ['环境采样异常：', reason(snapshot && snapshot.reason)]
      ],
      executionFields(samplingFields)
    ]);
    executionParagraphs.forEach(function (sentences) {
      paragraph(output, sentences.map(executionFields));
    });
    var audit = capabilities.audit || {};
    paragraph(output, [[
      ['操作审计', boolean(audit.enabled, '已启用', '未启用')], ['审计服务', boolean(audit.available, '正常', '暂不可用')],
      ['命令按', { hash: '哈希摘要', plain: '原文' }[audit.commandContent] || audit.commandContent, '记录']
    ]].concat(auditSentences.map(executionFields)));
    paragraph(output, [Array.from(remaining).map(function (key) { return [key, executionValue(key, execution[key])]; })]);
    return output;
  }
  function disk(sample) {
    if (!sample) return [];
    var output = [], undetected = [];
    if (sample.readOnly == null) undetected.push('只读状态');
    if (sample.quotaLimitBytes == null && sample.quotaRemainingBytes == null) undetected.push('磁盘配额');
    paragraph(output, [
      [
        ['磁盘空间：目录', sample.resolvedPath], ['所在文件系统共', bytes(sample.totalBytes)],
        ['可用', bytes(sample.availableBytes)], ['空闲', bytes(sample.freeBytes)]
      ],
      [
        ['文件系统', boolean(sample.readOnly, '只读', '非只读')],
        ['配额上限', bytes(sample.quotaLimitBytes)], ['剩余配额', bytes(sample.quotaRemainingBytes)],
        ['', undetected.join('和'), '尚未检测']
      ]
    ]);
    paragraph(output, [[
      ['采样于', time(sample.observedAt)], ['有效至', time(sample.expiresAt)],
      ['当前采样', sample.status === 'unavailable' ? '不可用' : sample.stale ? '来自历史记录' : ''],
      ['采样异常：', sample.reason === 'CONSTRAINTS_NOT_DETECTED' ? '' : reason(sample.reason)]
    ]]);
    return output;
  }
  function text(paragraphs) {
    return paragraphs.map(function (parts) { return parts.map(function (part) { return part.text; }).join(''); }).join('\n\n');
  }
  return Object.freeze({ environment: environment, disk: disk, text: text });
});
