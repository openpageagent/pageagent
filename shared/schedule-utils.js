// Shared schedule validation, local-time calculation, and public work calendars.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function localDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
      + '-' + String(date.getDate()).padStart(2, '0');
  }

  function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期必须是 YYYY-MM-DD');
    var date = new Date(value + 'T12:00:00');
    if (!isFinite(date.getTime()) || localDate(date) !== value) throw new Error('无效日期: ' + value);
    return date;
  }

  function times(trigger) {
    var values = trigger.times === undefined ? [trigger.time || '08:00'] : trigger.times;
    if (!Array.isArray(values) || !values.length || values.length > 1440) throw new Error('请选择至少一个运行时刻，最多 1440 个');
    values.forEach(function (value) {
      if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('运行时刻必须是 HH:mm');
    });
    return Array.from(new Set(values)).sort();
  }

  function dates(trigger) {
    if (!Array.isArray(trigger.dates) || !trigger.dates.length || trigger.dates.length > 366) throw new Error('请选择 1 至 366 个运行日期');
    trigger.dates.forEach(parseDate);
    return Array.from(new Set(trigger.dates)).sort();
  }

  function validate(schedule) {
    var trigger = schedule.trigger || {};
    var kind = trigger.kind || (schedule.cronExpression ? 'cron' : 'interval');
    if (kind === 'daily' || kind === 'dates') {
      times(trigger);
      if (kind === 'dates') dates(trigger);
    } else if (kind === 'interval') {
      if (trigger.minutes !== undefined && (!Number.isInteger(trigger.minutes) || trigger.minutes < 1)) throw new Error('间隔必须是大于等于 1 的整数分钟');
    } else if (kind !== 'cron') {
      throw new Error('未知触发方式: ' + kind);
    }
    if (trigger.dayFilter !== undefined && ['all', 'workday', 'holiday', 'restday'].indexOf(trigger.dayFilter) === -1) throw new Error('未知日期筛选方式');
    if (schedule.includeCalendar !== undefined && typeof schedule.includeCalendar !== 'boolean') throw new Error('获取日历信息必须为布尔值');
    var calendar = schedule.calendar || {};
    if (schedule.calendar !== undefined && (!schedule.calendar || typeof schedule.calendar !== 'object' || Array.isArray(schedule.calendar))) throw new Error('日历配置必须是对象');
    if (calendar.mode !== undefined && ['cn', 'publicHolidays', 'weekdays'].indexOf(calendar.mode) === -1) throw new Error('未知日历模式');
    if (calendar.mode === 'publicHolidays' && !/^[A-Z]{2}$/.test(calendar.countryCode || '')) throw new Error('请选择国家（两位大写国家代码）');
    if (calendar.mode === 'weekdays' && trigger.dayFilter === 'holiday') throw new Error('周一至周五模式无法判断法定节假日，请选择公开日历');
    if (calendar.days !== undefined) {
      if (!Array.isArray(calendar.days) || !calendar.days.length || calendar.days.length > 366) throw new Error('保存的日历应包含 1 至 366 天');
      var seenDates = Object.create(null);
      calendar.days.forEach(function (day) {
        if (!day || typeof day !== 'object') throw new Error('日历日期数据无效');
        parseDate(day.date);
        if (seenDates[day.date]) throw new Error('日历中存在重复日期: ' + day.date);
        seenDates[day.date] = true;
        if (day.mode !== (calendar.mode || 'cn')
            || day.mode === 'publicHolidays' && day.countryCode !== calendar.countryCode
            || typeof day.isWorkday !== 'boolean' || typeof day.isRestDay !== 'boolean' || day.isWorkday === day.isRestDay
            || day.isHoliday === true && !day.isRestDay
            || (typeof day.isHoliday !== 'boolean' && !(day.mode === 'weekdays' && day.isHoliday === null))) throw new Error('保存的日历与当前模式不匹配，请重新获取日历');
      });
    }
    if (schedule.includeCalendar || trigger.dayFilter && trigger.dayFilter !== 'all') {
      if (calendar.mode !== 'weekdays' && !calendar.days) throw new Error('请先获取并保存运行日期所需的公开日历');
      if (kind === 'dates') dates(trigger).forEach(function (date) { calendarDay(date, calendar); });
    }
    if (schedule.context !== undefined && (!schedule.context || typeof schedule.context !== 'object' || Array.isArray(schedule.context))) throw new Error('输入参数必须是 JSON 对象');
    if ((schedule.includeCalendar || trigger.dayFilter && trigger.dayFilter !== 'all')
        && Object.prototype.hasOwnProperty.call(schedule.context || {}, 'calendar')) throw new Error('获取日历时，输入参数不能使用保留字段 calendar');
  }

  function nextTime(trigger, afterMs) {
    var after = afterMs === undefined ? Date.now() : afterMs;
    var day = new Date(after);
    var dateValues;
    if (trigger.kind === 'dates') {
      dateValues = dates(trigger);
    } else {
      dateValues = [localDate(day)];
      day.setDate(day.getDate() + 1);
      dateValues.push(localDate(day));
      day.setDate(day.getDate() + 1);
      dateValues.push(localDate(day));
    }
    var timeValues = times(trigger);
    for (var i = 0; i < dateValues.length; i++) {
      for (var j = 0; j < timeValues.length; j++) {
        var candidate = new Date(dateValues[i] + 'T' + timeValues[j] + ':00');
        // Skip nonexistent local times during a daylight-saving transition.
        if (localDate(candidate) !== dateValues[i]
            || candidate.getHours() !== Number(timeValues[j].slice(0, 2))
            || candidate.getMinutes() !== Number(timeValues[j].slice(3))) continue;
        if (candidate.getTime() > after) return candidate.getTime();
      }
    }
    return null;
  }

  function matchesDay(filter, calendar) {
    if (!filter || filter === 'all') return true;
    if (filter === 'workday') return calendar.isWorkday;
    if (filter === 'holiday') return calendar.isHoliday;
    if (filter === 'restday') return calendar.isRestDay;
    throw new Error('未知日期筛选方式');
  }

  function dateRange(start, end) {
    var current = parseDate(start);
    parseDate(end);
    if (start > end) throw new Error('开始日期不能晚于结束日期');
    var result = [];
    while (localDate(current) <= end) {
      if (result.length >= 366) throw new Error('一次最多选择 366 天');
      result.push(localDate(current));
      current.setDate(current.getDate() + 1);
    }
    return result;
  }

  // Execution reads the saved snapshot only. Public calendars are fetched by the editor.
  function calendarDay(dateText, settings) {
    settings = settings || {};
    var date = parseDate(dateText);
    if (settings.mode === 'weekdays') {
      var weekend = date.getDay() === 0 || date.getDay() === 6;
      return { date: dateText, isWorkday: !weekend, isHoliday: null, isRestDay: weekend,
        isWeekend: weekend, name: '', mode: 'weekdays', source: 'weekdays' };
    }
    var day = (settings.days || []).find(function (entry) { return entry.date === dateText; });
    if (!day) throw new Error(dateText + ' 不在已保存的日历中，请在定时任务配置中获取对应日期的日历');
    return JSON.parse(JSON.stringify(day));
  }

  function parseAppleHolidays(text) {
    var lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    if (lines.indexOf('BEGIN:VCALENDAR') === -1 || lines.indexOf('END:VCALENDAR') === -1) throw new Error('iCloud 返回的内容不是有效的 ICS 日历');
    var days = Object.create(null);
    var event = null;

    function eventDate(value) {
      if (!/^\d{8}$/.test(value || '')) throw new Error('iCloud 放假调休事件缺少有效的全天日期');
      return parseDate(value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8));
    }

    function addEvent() {
      if (!event || event.STATUS === 'CANCELLED') return;
      var kind = event['X-APPLE-SPECIAL-DAY'];
      // Solar terms and observances are not days off. Only Apple's explicit work-calendar markers apply.
      if (kind !== 'WORK-HOLIDAY' && kind !== 'ALTERNATE-WORKDAY') return;
      if (event.RRULE || event.RDATE || event.EXDATE || event['RECURRENCE-ID']) throw new Error('iCloud 放假调休事件包含暂不支持的重复规则');
      var current = eventDate(event.DTSTART);
      var end = event.DTEND ? eventDate(event.DTEND) : new Date(current.getTime());
      if (!event.DTEND) end.setDate(end.getDate() + 1);
      if (end <= current) throw new Error('iCloud 放假调休事件的结束日期无效');
      var name = String(event.SUMMARY || '').replace(/\\([nN,;\\])/g, function (_, value) {
        return value === 'n' || value === 'N' ? '\n' : value;
      });
      var count = 0;
      // ICS DTEND is exclusive; an event without DTEND lasts one day.
      while (current < end) {
        if (++count > 366) throw new Error('iCloud 放假调休事件的日期跨度过大');
        var date = localDate(current);
        var isOffDay = kind === 'WORK-HOLIDAY';
        var previous = days[date];
        if (previous && previous.isOffDay !== isOffDay) throw new Error('iCloud 日历存在冲突的放假补班标记: ' + date);
        days[date] = { isOffDay: isOffDay, name: previous && previous.name !== name ? previous.name + '、' + name : name };
        current.setDate(current.getDate() + 1);
      }
    }

    lines.forEach(function (line) {
      if (line === 'BEGIN:VEVENT') {
        if (event) throw new Error('iCloud 日历事件格式无效');
        event = Object.create(null);
      } else if (line === 'END:VEVENT') {
        addEvent();
        event = null;
      } else if (event) {
        var separator = line.indexOf(':');
        if (separator > 0) event[line.slice(0, separator).split(';')[0].toUpperCase()] = line.slice(separator + 1);
      }
    });
    if (event || !Object.keys(days).length) throw new Error('iCloud 日历缺少有效的放假调休安排');
    return days;
  }

  function createCalendarReader(options) {
    options = options || {};
    var fetchData = options.fetch || globalThis.fetch.bind(globalThis);
    var requests = Object.create(null);
    function validPublicHolidays(data, year) {
      return Array.isArray(data) && data.length > 0 && data.every(function (day) {
        try {
          return parseDate(day.date).getFullYear() === year && typeof day.global === 'boolean' && Array.isArray(day.types);
        } catch (_) { return false; }
      });
    }

    function readCalendarData(year, mode, source) {
      var key = source;
      if (requests[key]) return requests[key];
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      // The same multi-year ICS is fetched once per explicit click, even across years.
      requests[key] = Promise.resolve().then(function () {
        return fetchData(source, { signal: controller.signal, cache: 'no-cache', credentials: 'omit' });
      }).then(function (response) {
        if (!response.ok) throw new Error('日历请求失败: HTTP ' + response.status);
        return mode === 'cn' ? response.text().then(parseAppleHolidays) : response.json();
      }).then(function (data) {
        if (mode !== 'cn' && !validPublicHolidays(data, year)) throw new Error('年度日历尚未发布或格式无效');
        return data;
      }).catch(function (error) {
        delete requests[key];
        throw error;
      }).finally(function () { clearTimeout(timeout); });
      return requests[key];
    }

    return function (dateText, settings) {
      var date = parseDate(dateText);
      settings = settings || {};
      var mode = settings.mode || 'cn';
      validate({ calendar: settings });
      var countryCode = mode === 'publicHolidays' ? settings.countryCode : 'CN';
      var year = date.getFullYear();
      var weekend = date.getDay() === 0 || date.getDay() === 6;
      if (mode === 'weekdays') return Promise.resolve(calendarDay(dateText, settings));
      var source = mode === 'cn'
        ? 'https://calendars.icloud.com/holidays/cn_zh.ics/'
        : 'https://date.nager.at/api/v3/PublicHolidays/' + year + '/' + countryCode;
      return readCalendarData(year, mode, source).then(function (data) {
        // Future observances alone do not establish that year's actual days off or makeup workdays.
        if (mode === 'cn' && !(data[year + '-01-01'] && data[year + '-01-01'].isOffDay
            && data[year + '-10-01'] && data[year + '-10-01'].isOffDay)) {
          throw new Error('iCloud 日历尚未包含 ' + year + ' 年完整的放假调休安排');
        }
        var day = mode === 'cn'
          ? data[dateText]
          : data.find(function (item) { return item.date === dateText && item.global && item.types.indexOf('Public') !== -1; });
        var holiday = !!(day && (mode !== 'cn' || day.isOffDay));
        var rest = mode === 'cn' && day ? day.isOffDay : holiday || weekend;
        return {
          date: dateText, isWorkday: !rest, isHoliday: holiday,
          isRestDay: rest, isWeekend: weekend, name: day ? String(day.localName || day.name || '') : '',
          mode: mode, countryCode: countryCode, source: source,
        };
      });
    };
  }

  return { localDate: localDate, parseDate: parseDate, times: times, dates: dates,
    validate: validate, nextTime: nextTime, matchesDay: matchesDay, dateRange: dateRange,
    calendarDay: calendarDay, createCalendarReader: createCalendarReader };
});
