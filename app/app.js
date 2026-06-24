/* 영어 문장 반복 학습 앱 — mobile PWA
 * Vanilla JS port of the Claude Design prototype (English Study App.dc.html).
 * - Reactive state -> full re-render of #app on setState (inputs kept in sync
 *   silently on 'input' so typing never triggers a re-render / focus loss).
 * - Persistence: localStorage. TTS: Web Speech API. Translation: Anthropic API
 *   via an on-device key (Settings), with manual English entry as fallback.
 */
(function () {
  'use strict';

  var LS_DATA = 'eng_learn_v1';
  var LS_KEY = 'anthropic_api_key';
  var TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';

  var root = document.getElementById('app');

  /* ──────────────────────────── State ──────────────────────────── */
  var state = {
    tab: 'today',
    data: {},
    today: '',
    showInput: false,
    editMode: false,
    showStudy: false,
    showSettings: false,
    koreanText: '',
    translating: false,
    translatedPairs: null,
    inputError: '',
    studySentences: [],
    studyIndex: 0,
    showEnglish: false,
    studyTitle: '',
    studyDate: null,
    speakingKorean: false,
    autoPlaying: false,
    autoPlayAll: false,
    playingEnglish: false,
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    statsPeriod: 'week',
    toast: ''
  };

  var toastTimer = null;
  var cachedVoices = [];

  function pickVoice(lang) {
    var voices = cachedVoices.length ? cachedVoices : (window.speechSynthesis ? window.speechSynthesis.getVoices() || [] : []);
    var langLow = lang.toLowerCase();
    var code = lang.slice(0, 2).toLowerCase();
    var exact = voices.filter(function (v) { return v.lang && v.lang.toLowerCase() === langLow; });
    var loose = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(code) === 0; });
    var pool = exact.length ? exact : loose;
    if (!pool.length) return null;
    var quality = ['enhanced', 'premium', 'neural', 'natural', 'wavenet', 'google'];
    var best = pool.filter(function (v) {
      return quality.some(function (k) { return v.name.toLowerCase().indexOf(k) >= 0; });
    });
    return (best[0] || pool[0]) || null;
  }

  function setState(patch) {
    var next = typeof patch === 'function' ? patch(state) : patch;
    for (var k in next) state[k] = next[k];
    render();
  }

  /* ─────────────────────────── Utilities ───────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }
  function dateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }
  function getTodayStr() { return dateStr(new Date()); }
  function fmtDate(s) {
    var p = s.split('-');
    return p[0] + '년 ' + (+p[1]) + '월 ' + (+p[2]) + '일';
  }
  function loadData() {
    try { return JSON.parse(localStorage.getItem(LS_DATA) || '{}'); }
    catch (e) { return {}; }
  }
  function saveData(data) {
    try { localStorage.setItem(LS_DATA, JSON.stringify(data)); } catch (e) {}
  }
  function isSat(d) { return d.getDay() === 6; }
  function isLastSun(d) {
    if (d.getDay() !== 0) return false;
    var n = new Date(d);
    n.setDate(d.getDate() + 7);
    return n.getMonth() !== d.getMonth();
  }
  function showToast(msg) {
    state.toast = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { setState({ toast: '' }); }, 3500);
  }

  /* ────────────────────────── Translation ──────────────────────── */
  async function translate() {
    var lines = state.koreanText.split('\n').map(function (l) { return l.trim(); })
      .filter(Boolean).slice(0, 10);
    if (!lines.length) { setState({ inputError: '문장을 입력해주세요.' }); return; }
    setState({ translating: true, inputError: '' });

    var key = '';
    try { key = localStorage.getItem(LS_KEY) || ''; } catch (e) {}

    if (!key) {
      setState({
        translatedPairs: lines.map(function (l) { return { korean: l, english: '' }; }),
        translating: false,
        inputError: '자동 번역을 사용하려면 우측 상단 ⚙️ 설정에서 API 키를 입력하세요. 또는 영어를 직접 입력해주세요.'
      });
      return;
    }

    try {
      var prompt = 'Translate the following Korean sentences into natural, conversational English.\n' +
        'Rules:\n' +
        '- Use everyday spoken English, not formal or textbook style\n' +
        '- Keep the tone and nuance of the original\n' +
        '- Short Korean sentences should become short English sentences\n' +
        'Respond ONLY with a JSON array, no other text: [{"korean":"...","english":"..."}]\n\n' +
        lines.map(function (l, i) { return (i + 1) + '. ' + l; }).join('\n');

      var resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: TRANSLATE_MODEL,
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!resp.ok) {
        var detail = '';
        try { var ej = await resp.json(); detail = (ej.error && ej.error.message) ? ' · ' + ej.error.message : ''; } catch (e) {}
        throw new Error('HTTP ' + resp.status + detail);
      }
      var body = await resp.json();
      var text = (body.content || []).map(function (b) { return b.text || ''; }).join('');

      var pairs;
      var arrMatch = text.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        pairs = JSON.parse(arrMatch[0]);
      } else {
        var codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeMatch) pairs = JSON.parse(codeMatch[1]);
        else throw new Error('no json');
      }
      setState({
        translatedPairs: pairs.map(function (p) { return { korean: p.korean, english: p.english || '' }; }),
        translating: false
      });
    } catch (e) {
      setState({
        translatedPairs: lines.map(function (l) { return { korean: l, english: '' }; }),
        translating: false,
        inputError: '번역 오류 (' + e.message + '). 영어를 직접 입력해주세요.'
      });
    }
  }

  // Pull current English <input> values from the DOM into state before any
  // re-render of the translated view, so typed text is never lost.
  function syncPairsFromDom() {
    if (!state.translatedPairs) return;
    var inputs = root.querySelectorAll('input[data-model="pairEnglish"]');
    for (var i = 0; i < inputs.length; i++) {
      var idx = +inputs[i].getAttribute('data-index');
      if (state.translatedPairs[idx]) state.translatedPairs[idx].english = inputs[i].value;
    }
  }

  function saveSentencesAndStudy() {
    syncPairsFromDom();
    var tp = state.translatedPairs;
    if (!tp) return;
    if (tp.some(function (p) { return !p.english.trim(); })) {
      setState({ inputError: '모든 영어 번역을 입력해주세요.' });
      return;
    }
    var existing = (state.data[state.today] && state.data[state.today].sentences) || [];
    var sentences = tp.map(function (p, i) {
      var prev = existing.filter(function (s) { return s.korean === p.korean; })[0];
      return { id: i, korean: p.korean, english: p.english, completed: prev ? prev.completed : false };
    });
    var newData = Object.assign({}, state.data);
    newData[state.today] = { date: state.today, sentences: sentences };
    saveData(newData);
    state.data = newData;
    state.showInput = false;
    state.koreanText = '';
    state.translatedPairs = null;
    var wasEdit = state.editMode;
    state.editMode = false;
    if (wasEdit) {
      showToast('✅ 문장이 수정되었습니다');
    } else {
      startStudy(sentences, state.today, '오늘의 학습');
    }
  }

  /* ───────────────────────── Study session ─────────────────────── */
  function startStudy(sentences, dateKey, title) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({
      showStudy: true, showInput: false, studySentences: sentences, studyIndex: 0,
      showEnglish: false, studyTitle: title || '', studyDate: dateKey,
      speakingKorean: false, autoPlaying: false, autoPlayAll: false, playingEnglish: false
    });
  }
  function endStudy() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ showStudy: false, autoPlaying: false, autoPlayAll: false, speakingKorean: false, playingEnglish: false });
  }
  function speak(text, lang) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis) { resolve(); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = lang.indexOf('ko') === 0 ? 0.78 : 0.88;
      u.pitch = 1;
      try { var v = pickVoice(lang); if (v) u.voice = v; } catch (e) {}
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
    });
  }
  async function playCurrent() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ showEnglish: false, speakingKorean: true, autoPlaying: true });
    while (state.autoPlaying) {
      var s = state.studySentences[state.studyIndex];
      if (!s) break;
      setState({ showEnglish: false, speakingKorean: true });
      await speak(s.korean, 'ko-KR');
      if (!state.autoPlaying) break;
      await new Promise(function (r) { setTimeout(r, 2000); });
      if (!state.autoPlaying) break;
      setState({ showEnglish: true, speakingKorean: false });
      await speak(s.english, 'en-US');
      if (!state.autoPlaying) break;
      await new Promise(function (r) { setTimeout(r, 800); });
    }
  }
  async function playEnglish() {
    var s = state.studySentences[state.studyIndex];
    if (!s) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ showEnglish: true, speakingKorean: false, playingEnglish: true });
    await speak(s.english, 'en-US');
    setState({ playingEnglish: false });
  }
  function stopAudio() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ autoPlaying: false, autoPlayAll: false, speakingKorean: false, playingEnglish: false });
  }
  async function playAll() {
    var sents = state.studySentences;
    if (!sents.length) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ autoPlayAll: true, autoPlaying: true, studyIndex: 0, showEnglish: false, speakingKorean: false });
    for (var i = 0; i < sents.length; i++) {
      if (!state.autoPlayAll) break;
      var s = sents[i];
      setState({ studyIndex: i, showEnglish: false, speakingKorean: true });
      await speak(s.korean, 'ko-KR');
      if (!state.autoPlayAll) break;
      await new Promise(function (r) { setTimeout(r, 2000); });
      if (!state.autoPlayAll) break;
      setState({ showEnglish: true, speakingKorean: false });
      await speak(s.english, 'en-US');
      if (!state.autoPlayAll) break;
      if (i < sents.length - 1) await new Promise(function (r) { setTimeout(r, 1200); });
    }
    if (state.autoPlayAll) {
      setState({ autoPlayAll: false, autoPlaying: false, speakingKorean: false });
      showToast('✅ 전체 학습 완료!');
    }
  }
  function goToSentence(i) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState({ studyIndex: i, showEnglish: false, autoPlaying: false, autoPlayAll: false, speakingKorean: false, playingEnglish: false });
  }
  function nextSentence() {
    if (state.studyIndex < state.studySentences.length - 1) goToSentence(state.studyIndex + 1);
  }
  function prevSentence() {
    if (state.studyIndex > 0) goToSentence(state.studyIndex - 1);
  }
  function toggleComplete(idx) {
    var s = state.studySentences[idx];
    var dateKey = state.studyDate || (s && s.fromDate);
    if (!dateKey || !state.data[dateKey]) return;

    var newData = JSON.parse(JSON.stringify(state.data));
    var sents = newData[dateKey].sentences;
    var di = sents.findIndex(function (x) { return x.korean === s.korean; });
    if (di < 0) return;

    sents[di].completed = !sents[di].completed;
    saveData(newData);

    var newStudy = state.studySentences.slice();
    newStudy[idx] = Object.assign({}, newStudy[idx], { completed: sents[di].completed });
    state.data = newData;
    state.studySentences = newStudy;
    showToast(sents[di].completed ? '✅ 완료 표시했습니다!' : '↩️ 완료를 취소했습니다');
  }

  /* ───────────────────────────── Reviews ───────────────────────── */
  function startPrevDayReview() {
    var data = state.data, today = state.today, sents = [];
    Object.keys(data).filter(function (x) { return x < today; }).sort().forEach(function (d) {
      if (data[d] && data[d].sentences) {
        data[d].sentences.filter(function (s) { return !s.completed; }).forEach(function (s) {
          sents.push(Object.assign({}, s, { fromDate: d }));
        });
      }
    });
    if (!sents.length) { showToast('미완료 문장이 없습니다! 모두 완료했어요 🎉'); return; }
    startStudy(sents, null, '이전 미완료 복습 (' + sents.length + '개)');
  }
  function startWeeklyReview() {
    var data = state.data;
    var today = new Date();
    var day = today.getDay();
    var monday = new Date(today);
    monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
    var sents = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday);
      d.setDate(monday.getDate() + i);
      var ds = dateStr(d);
      if (data[ds] && data[ds].sentences) {
        data[ds].sentences.forEach(function (s) { sents.push(Object.assign({}, s, { fromDate: ds })); });
      }
    }
    if (!sents.length) { showToast('이번 주 학습 문장이 없습니다.'); return; }
    startStudy(sents, null, '주간 복습 (' + sents.length + '개)');
  }
  function startMonthlyReview() {
    var data = state.data;
    var parts = state.today.split('-').map(Number);
    var y = parts[0], m = parts[1], sents = [];
    Object.keys(data).forEach(function (ds) {
      var dp = ds.split('-').map(Number);
      if (dp[0] === y && dp[1] === m && data[ds].sentences) {
        data[ds].sentences.filter(function (s) { return !s.completed; }).forEach(function (s) {
          sents.push(Object.assign({}, s, { fromDate: ds }));
        });
      }
    });
    if (!sents.length) { showToast('이번 달 미완료 문장이 없습니다! 🎉'); return; }
    startStudy(sents, null, '월간 미완료 복습 (' + sents.length + '개)');
  }

  /* ───────────────────────────── Calendar ──────────────────────── */
  function prevMonth() {
    var y = state.calYear, m = state.calMonth - 1;
    if (m < 0) { m = 11; y--; }
    setState({ calYear: y, calMonth: m });
  }
  function nextMonth() {
    var y = state.calYear, m = state.calMonth + 1;
    if (m > 11) { m = 0; y++; }
    setState({ calYear: y, calMonth: m });
  }
  function getCalCells() {
    var calYear = state.calYear, calMonth = state.calMonth, data = state.data, today = state.today;
    var first = new Date(calYear, calMonth, 1).getDay();
    var dims = new Date(calYear, calMonth + 1, 0).getDate();
    var cells = [];
    function empty() {
      return { isEmpty: true, isDay: false };
    }
    for (var i = 0; i < first; i++) cells.push(empty());

    for (var d = 1; d <= dims; d++) {
      var ds = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var dd = data[ds];
      var total = dd ? dd.sentences.length : 0;
      var done = dd ? dd.sentences.filter(function (s) { return s.completed; }).length : 0;
      var pct = total > 0 ? done / total : -1;
      var isT = ds === today;

      var bg = 'transparent', border = '1.5px solid transparent', tc = '#374151', dot = null;
      if (isT) { bg = '#EEF2FF'; border = '2px solid #818CF8'; tc = '#4F46E5'; }
      if (pct === 1) { bg = '#ECFDF5'; border = '1.5px solid #A7F3D0'; dot = '#10B981'; if (isT) border = '2px solid #818CF8'; }
      else if (pct > 0) { bg = '#FFFBEB'; border = '1.5px solid #FDE68A'; dot = '#F59E0B'; if (isT) border = '2px solid #818CF8'; }
      else if (pct === 0 && total > 0) { bg = '#FEF2F2'; border = '1.5px solid #FECACA'; dot = '#EF4444'; if (isT) border = '2px solid #818CF8'; }

      cells.push({
        isEmpty: false, isDay: true, day: d, dateStr: ds,
        total: total, hasSentences: total > 0,
        bg: bg, border: border, tc: tc,
        dot: dot || (isT ? '#818CF8' : ''),
        showDot: !!dot || (isT && total > 0),
        cursor: total > 0 ? 'pointer' : 'default'
      });
    }
    while (cells.length % 7 !== 0) cells.push(empty());
    return cells;
  }

  /* ────────────────────────────── Stats ────────────────────────── */
  function getStatsData(period) {
    var data = state.data, today = state.today;
    var n = period === 'week' ? 7 : 30;
    var days = ['일', '월', '화', '수', '목', '금', '토'];
    var rows = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var ds = dateStr(d);
      var dd = data[ds];
      var total = dd ? dd.sentences.length : 0;
      var done = dd ? dd.sentences.filter(function (s) { return s.completed; }).length : 0;
      var pct = total > 0 ? Math.round(done / total * 100) : 0;
      rows.push({
        ds: ds, total: total, done: done, pct: pct, isToday: ds === today,
        label: period === 'week' ? days[d.getDay()] : (d.getMonth() + 1) + '/' + d.getDate()
      });
    }
    var maxPct = Math.max.apply(null, rows.map(function (r) { return r.pct; }).concat([1]));
    return rows.map(function (r) {
      return Object.assign({}, r, {
        barH: r.total > 0 ? Math.max(4, Math.round(r.pct / maxPct * 96)) : 0,
        minH: r.total > 0 ? 4 : 0,
        barColor: r.pct >= 80 ? '#10B981' : r.pct >= 40 ? '#4F46E5' : r.pct > 0 ? '#F59E0B' : (r.total > 0 ? '#FCA5A5' : '#E5E7EB'),
        pctLbl: r.total > 0 ? r.pct + '%' : '',
        dayColor: r.isToday ? '#4F46E5' : '#9CA3AF',
        dayWeight: r.isToday ? '700' : '400'
      });
    });
  }
  function getStreak() {
    var data = state.data;
    var count = 0;
    var d = new Date(state.today);
    while (true) {
      var ds = dateStr(d);
      if (data[ds] && data[ds].sentences && data[ds].sentences.length > 0) {
        count++;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    return count;
  }
  function getRecentDays() {
    var data = state.data;
    var days = ['일', '월', '화', '수', '목', '금', '토'];
    var result = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var ds = dateStr(d);
      var dd = data[ds];
      var total = dd ? dd.sentences.length : 0;
      var done = dd ? dd.sentences.filter(function (s) { return s.completed; }).length : 0;
      var pct = total > 0 ? Math.round(done / total * 100) : 0;
      if (total > 0) {
        result.push({
          label: (d.getMonth() + 1) + '/' + d.getDate() + ' (' + days[d.getDay()] + ')',
          label2: done + '/' + total,
          pct: pct,
          barClr: pct >= 80 ? '#10B981' : pct >= 40 ? '#4F46E5' : '#F59E0B'
        });
      }
    }
    return result;
  }

  /* ─────────────────────────── Actions map ─────────────────────── */
  var actions = {
    goToday: function () { setState({ tab: 'today' }); },
    goCalendar: function () { setState({ tab: 'calendar' }); },
    goStats: function () { setState({ tab: 'stats' }); },
    openSettings: function () { setState({ showSettings: true }); },
    closeSettings: function () { setState({ showSettings: false }); },
    saveSettings: function () {
      var el = root.querySelector('input[data-model="apiKey"]');
      var val = el ? el.value.trim() : '';
      try {
        if (val) localStorage.setItem(LS_KEY, val);
        else localStorage.removeItem(LS_KEY);
      } catch (e) {}
      setState({ showSettings: false });
      showToast(val ? '🔑 API 키를 저장했습니다' : '키를 삭제했습니다 (수동 입력 모드)');
    },
    openInput: function () { setState({ showInput: true, editMode: false, koreanText: '', translatedPairs: null, inputError: '' }); },
    openEdit: function () {
      var td = state.data[state.today];
      if (!td || !td.sentences) return;
      var pairs = td.sentences.map(function (s) { return { korean: s.korean, english: s.english }; });
      setState({ showInput: true, editMode: true, koreanText: pairs.map(function (p) { return p.korean; }).join('\n'), translatedPairs: pairs, inputError: '' });
    },
    closeInput: function () { syncPairsFromDom(); setState({ showInput: false, editMode: false }); },
    doTranslate: function () { translate(); },
    resetInput: function () { setState({ translatedPairs: null, inputError: '' }); },
    doSave: function () { saveSentencesAndStudy(); },
    studyToday: function () {
      var td = state.data[state.today];
      startStudy(td ? td.sentences : [], state.today, '오늘의 학습');
    },
    reviewPrev: startPrevDayReview,
    reviewWeekly: startWeeklyReview,
    reviewMonthly: startMonthlyReview,
    endStudy: endStudy,
    nextS: nextSentence,
    prevS: prevSentence,
    showEng: function () { setState({ showEnglish: true }); },
    prevMonth: prevMonth,
    nextMonth: nextMonth,
    setWeek: function () { setState({ statsPeriod: 'week' }); },
    setMonth: function () { setState({ statsPeriod: 'month' }); },
    toggleComplete: function () { toggleComplete(state.studyIndex); },
    playBtn: function () { (state.autoPlaying || state.autoPlayAll) ? stopAudio() : playCurrent(); },
    playAllBtn: function () { state.autoPlayAll ? stopAudio() : playAll(); },
    playEngBtn: function () { state.playingEnglish ? stopAudio() : playEnglish(); },
    calCell: function (el) {
      var ds = el.getAttribute('data-date');
      var dd = state.data[ds];
      if (dd && dd.sentences.length) startStudy(dd.sentences, ds, fmtDate(ds));
    },
    dot: function (el) { goToSentence(+el.getAttribute('data-index')); }
  };

  /* ─────────────────────────── Rendering ───────────────────────── */
  function render() {
    root.innerHTML = view();
    // Push state-backed values into uncontrolled inputs after each render.
    var ta = root.querySelector('textarea[data-model="koreanText"]');
    if (ta) ta.value = state.koreanText;
    var pe = root.querySelectorAll('input[data-model="pairEnglish"]');
    for (var i = 0; i < pe.length; i++) {
      var idx = +pe[i].getAttribute('data-index');
      if (state.translatedPairs && state.translatedPairs[idx]) pe[i].value = state.translatedPairs[idx].english || '';
    }
    var ak = root.querySelector('input[data-model="apiKey"]');
    if (ak && ak.getAttribute('data-init') === '1') {
      try { ak.value = localStorage.getItem(LS_KEY) || ''; } catch (e) {}
      ak.setAttribute('data-init', '0');
    }
  }

  function view() {
    var now = new Date();
    var sat = isSat(now);
    var lastSun = isLastSun(now);
    var weekdayNames = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    var todayFmt = now.getFullYear() + '년 ' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + weekdayNames[now.getDay()];

    var todayData = state.data[state.today] || { sentences: [] };
    var todayS = todayData.sentences;
    var todayDone = todayS.filter(function (s) { return s.completed; }).length;
    var todayTotal = todayS.length;
    var hasTodayS = todayTotal > 0;
    var todayPct = todayTotal > 0 ? Math.round(todayDone / todayTotal * 100) : 0;

    var prevIncomplete = 0;
    Object.keys(state.data).filter(function (x) { return x < state.today; }).forEach(function (d) {
      if (state.data[d] && state.data[d].sentences) {
        prevIncomplete += state.data[d].sentences.filter(function (s) { return !s.completed; }).length;
      }
    });

    var html = '';
    html += '<div style="max-width:430px; margin:0 auto; min-height:100vh; background:#EEF2FF; display:flex; flex-direction:column; position:relative;">';

    /* HEADER */
    html += '<div style="background:white; padding:16px 20px 12px; box-shadow:0 1px 0 #E5E7EB; position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between;">';
    html += '<div>';
    html += '<div style="font-size:11px; color:#9CA3AF; font-weight:500; letter-spacing:0.02em;">' + esc(todayFmt) + '</div>';
    html += '<div style="font-size:22px; font-weight:900; color:#1E1B4B; margin-top:1px; letter-spacing:-0.5px;">영어 학습</div>';
    html += '</div>';
    html += '<div style="display:flex; align-items:center; gap:8px;">';
    if (sat) html += '<div style="background:#FEF3C7; color:#D97706; padding:6px 12px; border-radius:16px; font-size:12px; font-weight:700;">📅 주간복습</div>';
    if (lastSun) html += '<div style="background:#FCE7F3; color:#DB2777; padding:6px 12px; border-radius:16px; font-size:12px; font-weight:700;">📊 월간복습</div>';
    html += '<button data-action="openSettings" aria-label="설정" style="width:36px; height:36px; border-radius:10px; background:#F3F4F6; border:none; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center;">⚙️</button>';
    html += '</div>';
    html += '</div>';

    /* CONTENT */
    html += '<div style="flex:1; overflow-y:auto; padding-bottom:82px;">';
    if (state.tab === 'today') html += todayTab({ sat: sat, lastSun: lastSun, hasTodayS: hasTodayS, todayS: todayS, todayDone: todayDone, todayTotal: todayTotal, todayPct: todayPct, prevIncomplete: prevIncomplete });
    if (state.tab === 'calendar') html += calendarTab();
    if (state.tab === 'stats') html += statsTab();
    html += '</div>';

    /* BOTTOM NAV */
    html += bottomNav();

    /* TOAST */
    if (state.toast) {
      html += '<div style="position:fixed; bottom:92px; left:50%; transform:translateX(-50%); background:rgba(30,27,75,0.92); color:white; padding:11px 20px; border-radius:24px; font-size:13px; font-weight:500; z-index:100; box-shadow:0 4px 20px rgba(0,0,0,0.25); animation:fadeUp 0.3s ease; max-width:340px; text-align:center;">' + esc(state.toast) + '</div>';
    }

    /* OVERLAYS */
    if (state.showInput) html += inputOverlay();
    if (state.showStudy) html += studyOverlay();
    if (state.showSettings) html += settingsOverlay();

    html += '</div>';
    return html;
  }

  function todayTab(v) {
    var h = '<div style="padding:16px; display:flex; flex-direction:column; gap:14px;">';

    if (v.prevIncomplete > 0) {
      h += '<div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:14px; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:10px;">' +
        '<div><div style="font-size:13px; font-weight:700; color:#92400E;">⚠️ 미완료 문장</div>' +
        '<div style="font-size:12px; color:#B45309; margin-top:2px;">' + v.prevIncomplete + '개 문장이 완료되지 않았어요</div></div>' +
        '<button data-action="reviewPrev" style="background:#F59E0B; color:white; border:none; padding:9px 14px; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap; flex-shrink:0;">복습하기</button>' +
        '</div>';
    }

    if (v.sat) {
      h += '<div style="background:linear-gradient(135deg,#667EEA 0%,#764BA2 100%); border-radius:18px; padding:22px; color:white;">' +
        '<div style="font-size:18px; font-weight:800; margin-bottom:6px;">📚 주간 복습의 날</div>' +
        '<div style="font-size:13px; opacity:0.88; line-height:1.6; margin-bottom:18px;">이번 주 학습한 모든 문장을 복습하세요<br>토요일에는 새 문장을 입력하지 않아요</div>' +
        '<button data-action="reviewWeekly" style="background:rgba(255,255,255,0.18); border:1.5px solid rgba(255,255,255,0.4); color:white; padding:13px; border-radius:12px; font-size:15px; font-weight:700; cursor:pointer; width:100%;">주간 복습 시작하기 →</button>' +
        '</div>';
    }

    if (v.lastSun) {
      h += '<div style="background:linear-gradient(135deg,#F093FB 0%,#F5576C 100%); border-radius:18px; padding:22px; color:white;">' +
        '<div style="font-size:18px; font-weight:800; margin-bottom:6px;">🎯 월간 복습의 날</div>' +
        '<div style="font-size:13px; opacity:0.88; line-height:1.6; margin-bottom:18px;">이번 달 완료되지 않은 문장을 복습하세요</div>' +
        '<button data-action="reviewMonthly" style="background:rgba(255,255,255,0.18); border:1.5px solid rgba(255,255,255,0.4); color:white; padding:13px; border-radius:12px; font-size:15px; font-weight:700; cursor:pointer; width:100%;">월간 복습 시작하기 →</button>' +
        '</div>';
    }

    if (v.hasTodayS) {
      h += '<div style="background:white; border-radius:18px; padding:20px; box-shadow:0 2px 14px rgba(79,70,229,0.08);">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">' +
        '<div><div style="font-size:16px; font-weight:800; color:#1E1B4B;">오늘의 문장</div>' +
        '<div style="font-size:12px; color:#6B7280; margin-top:3px;">' + v.todayDone + ' / ' + v.todayTotal + '개 완료</div></div>' +
        '<div style="display:flex; gap:8px;">' +
        '<button data-action="openEdit" style="background:#F3F4F6; color:#374151; border:none; padding:10px 14px; border-radius:12px; font-size:14px; font-weight:600; cursor:pointer;">편집</button>' +
        '<button data-action="studyToday" style="background:#4F46E5; color:white; border:none; padding:10px 18px; border-radius:12px; font-size:14px; font-weight:700; cursor:pointer;">학습 시작</button>' +
        '</div>' +
        '</div>' +
        '<div style="background:#F3F4F6; border-radius:6px; height:6px; overflow:hidden; margin-bottom:16px;">' +
        '<div style="background:#10B981; height:100%; width:' + v.todayPct + '%; border-radius:6px; transition:width 0.5s;"></div></div>' +
        '<div style="display:flex; flex-direction:column; gap:6px;">';
      v.todayS.forEach(function (s, i) {
        var dotBg = s.completed ? '#10B981' : '#EEF2FF';
        var dotClr = s.completed ? 'white' : '#4F46E5';
        var rowBg = s.completed ? '#F0FDF4' : '#F9FAFB';
        h += '<div style="display:flex; align-items:center; gap:10px; padding:9px 10px; background:' + rowBg + '; border-radius:10px;">' +
          '<div style="width:26px; height:26px; border-radius:8px; background:' + dotBg + '; display:flex; align-items:center; justify-content:center; flex-shrink:0;">' +
          '<span style="font-size:11px; font-weight:800; color:' + dotClr + ';">' + (i + 1) + '</span></div>' +
          '<div style="font-size:13px; color:#374151; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(s.korean) + '</div>' +
          '</div>';
      });
      h += '</div></div>';
    }

    // Empty state (only on normal days, matching the design's noTodayS)
    if (!v.hasTodayS && !v.sat && !v.lastSun) {
      h += '<div style="background:white; border-radius:18px; padding:44px 24px; text-align:center; box-shadow:0 2px 14px rgba(79,70,229,0.08);">' +
        '<div style="font-size:56px; margin-bottom:18px;">✏️</div>' +
        '<div style="font-size:20px; font-weight:800; color:#1E1B4B; margin-bottom:8px;">오늘의 문장을 입력하세요</div>' +
        '<div style="font-size:14px; color:#6B7280; line-height:1.7; margin-bottom:28px;">10개의 한국어 문장을 입력하면<br>자동으로 영어로 번역해드립니다</div>' +
        '<button data-action="openInput" style="background:#4F46E5; color:white; border:none; padding:16px; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; width:100%;">+ 문장 입력하기</button>' +
        '</div>';
    }

    h += '</div>';
    return h;
  }

  function calendarTab() {
    var calMonthNames = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
    var calTitle = state.calYear + '년 ' + calMonthNames[state.calMonth];
    var cells = getCalCells();

    var h = '<div style="padding:16px;">';
    h += '<div style="background:white; border-radius:18px; overflow:hidden; box-shadow:0 2px 14px rgba(79,70,229,0.08);">';
    h += '<div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #F3F4F6;">' +
      '<button data-action="prevMonth" style="background:#F3F4F6; border:none; width:36px; height:36px; border-radius:10px; font-size:18px; cursor:pointer; color:#374151; display:flex; align-items:center; justify-content:center;">‹</button>' +
      '<div style="font-size:16px; font-weight:800; color:#1E1B4B;">' + esc(calTitle) + '</div>' +
      '<button data-action="nextMonth" style="background:#F3F4F6; border:none; width:36px; height:36px; border-radius:10px; font-size:18px; cursor:pointer; color:#374151; display:flex; align-items:center; justify-content:center;">›</button>' +
      '</div>';

    var dayHdr = [['일', '#EF4444'], ['월', '#6B7280'], ['화', '#6B7280'], ['수', '#6B7280'], ['목', '#6B7280'], ['금', '#6B7280'], ['토', '#3B82F6']];
    h += '<div style="display:grid; grid-template-columns:repeat(7,1fr); padding:10px 10px 4px; gap:0;">';
    dayHdr.forEach(function (d) {
      h += '<div style="text-align:center; font-size:11px; font-weight:700; color:' + d[1] + '; padding:4px 0;">' + d[0] + '</div>';
    });
    h += '</div>';

    h += '<div style="display:grid; grid-template-columns:repeat(7,1fr); padding:0 10px 10px; gap:2px;">';
    cells.forEach(function (cell) {
      if (cell.isDay) {
        var clickAttrs = cell.hasSentences ? ' data-action="calCell" data-date="' + cell.dateStr + '"' : '';
        h += '<div' + clickAttrs + ' style="padding:2px; cursor:' + cell.cursor + ';">' +
          '<div style="border-radius:10px; background:' + cell.bg + '; border:' + cell.border + '; text-align:center; min-height:44px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;">' +
          '<div style="font-size:13px; font-weight:500; color:' + cell.tc + ';">' + cell.day + '</div>' +
          (cell.showDot ? '<div style="width:5px; height:5px; border-radius:50%; background:' + cell.dot + ';"></div>' : '') +
          '</div></div>';
      } else {
        h += '<div style="padding:2px; min-height:44px;"></div>';
      }
    });
    h += '</div>';

    h += '<div style="padding:10px 20px 16px; border-top:1px solid #F9FAFB;">' +
      '<div style="display:flex; gap:14px; font-size:11px; color:#9CA3AF;">' +
      '<div style="display:flex; align-items:center; gap:4px;"><div style="width:7px; height:7px; border-radius:50%; background:#10B981;"></div>모두 완료</div>' +
      '<div style="display:flex; align-items:center; gap:4px;"><div style="width:7px; height:7px; border-radius:50%; background:#F59E0B;"></div>일부 완료</div>' +
      '<div style="display:flex; align-items:center; gap:4px;"><div style="width:7px; height:7px; border-radius:50%; background:#EF4444;"></div>미완료</div>' +
      '</div></div>';

    h += '</div></div>';
    return h;
  }

  function statsTab() {
    var statsD = getStatsData(state.statsPeriod);
    var allS = [];
    Object.keys(state.data).forEach(function (k) { allS = allS.concat(state.data[k].sentences || []); });
    var totalDays = Object.keys(state.data).filter(function (d) { return state.data[d].sentences && state.data[d].sentences.length; }).length;
    var totalDone = allS.filter(function (s) { return s.completed; }).length;
    var streak = getStreak();
    var recentDays = getRecentDays();

    var weekBg = state.statsPeriod === 'week' ? '#4F46E5' : 'transparent';
    var weekClr = state.statsPeriod === 'week' ? 'white' : '#6B7280';
    var monthBg = state.statsPeriod === 'month' ? '#4F46E5' : 'transparent';
    var monthClr = state.statsPeriod === 'month' ? 'white' : '#6B7280';

    var h = '<div style="padding:16px; display:flex; flex-direction:column; gap:14px;">';

    // Summary tiles
    h += '<div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">' +
      tile(totalDays, '학습일', '#4F46E5') +
      tile(totalDone, '완료 문장', '#10B981') +
      tile(streak, '연속 학습', '#F59E0B') +
      '</div>';

    // Chart card
    h += '<div style="background:white; border-radius:18px; padding:20px; box-shadow:0 2px 14px rgba(79,70,229,0.08);">' +
      '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:18px;">' +
      '<div style="font-size:15px; font-weight:800; color:#1E1B4B;">완료율 현황</div>' +
      '<div style="display:flex; background:#F3F4F6; border-radius:8px; padding:2px; gap:2px;">' +
      '<button data-action="setWeek" style="padding:6px 12px; border-radius:6px; border:none; font-size:12px; font-weight:700; cursor:pointer; background:' + weekBg + '; color:' + weekClr + '; transition:all 0.2s;">7일</button>' +
      '<button data-action="setMonth" style="padding:6px 12px; border-radius:6px; border:none; font-size:12px; font-weight:700; cursor:pointer; background:' + monthBg + '; color:' + monthClr + '; transition:all 0.2s;">30일</button>' +
      '</div></div>';

    h += '<div style="display:flex; gap:3px; align-items:flex-end; height:110px; border-bottom:1px solid #F3F4F6; padding-bottom:4px;">';
    statsD.forEach(function (bar) {
      h += '<div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; gap:2px;">' +
        '<div style="font-size:8px; color:#9CA3AF; height:12px; line-height:12px;">' + bar.pctLbl + '</div>' +
        '<div style="width:76%; background:' + bar.barColor + '; border-radius:4px 4px 0 0; height:' + bar.barH + 'px; min-height:' + bar.minH + 'px; transition:height 0.5s ease;"></div>' +
        '</div>';
    });
    h += '</div>';

    h += '<div style="display:flex; gap:3px; margin-top:6px;">';
    statsD.forEach(function (bar) {
      h += '<div style="flex:1; text-align:center; font-size:10px; font-weight:' + bar.dayWeight + '; color:' + bar.dayColor + ';">' + esc(bar.label) + '</div>';
    });
    h += '</div></div>';

    // History card
    h += '<div style="background:white; border-radius:18px; padding:20px; box-shadow:0 2px 14px rgba(79,70,229,0.08);">' +
      '<div style="font-size:15px; font-weight:800; color:#1E1B4B; margin-bottom:14px;">학습 기록</div>';
    if (recentDays.length) {
      recentDays.forEach(function (rd) {
        h += '<div style="display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid #F9FAFB;">' +
          '<div style="font-size:13px; color:#6B7280; font-weight:500; width:80px; flex-shrink:0;">' + esc(rd.label) + '</div>' +
          '<div style="flex:1; background:#F3F4F6; border-radius:4px; height:8px; overflow:hidden;">' +
          '<div style="background:' + rd.barClr + '; height:100%; width:' + rd.pct + '%; border-radius:4px; transition:width 0.5s;"></div></div>' +
          '<div style="font-size:12px; color:#374151; font-weight:600; width:50px; text-align:right; flex-shrink:0;">' + esc(rd.label2) + '</div>' +
          '</div>';
      });
    } else {
      h += '<div style="font-size:13px; color:#9CA3AF; text-align:center; padding:18px 0;">최근 7일간 학습 기록이 없어요</div>';
    }
    h += '</div>';

    h += '</div>';
    return h;
  }

  function tile(num, label, color) {
    return '<div style="background:white; border-radius:14px; padding:16px 10px; text-align:center; box-shadow:0 2px 8px rgba(79,70,229,0.07);">' +
      '<div style="font-size:28px; font-weight:900; color:' + color + ';">' + num + '</div>' +
      '<div style="font-size:11px; color:#9CA3AF; margin-top:2px; font-weight:500;">' + label + '</div></div>';
  }

  function bottomNav() {
    var todayClr = state.tab === 'today' ? '#4F46E5' : '#9CA3AF';
    var calClr = state.tab === 'calendar' ? '#4F46E5' : '#9CA3AF';
    var statsClr = state.tab === 'stats' ? '#4F46E5' : '#9CA3AF';
    function btn(action, icon, label, clr) {
      return '<button data-action="' + action + '" style="flex:1; display:flex; flex-direction:column; align-items:center; padding:10px 0 8px; background:none; border:none; cursor:pointer; gap:2px;">' +
        '<span style="font-size:22px;">' + icon + '</span>' +
        '<span style="font-size:11px; font-weight:700; color:' + clr + ';">' + label + '</span></button>';
    }
    return '<div style="position:fixed; bottom:0; left:50%; transform:translateX(-50%); width:100%; max-width:430px; background:white; border-top:1px solid #E5E7EB; display:flex; z-index:20; padding-bottom:env(safe-area-inset-bottom,0px);">' +
      btn('goToday', '🏠', '오늘', todayClr) +
      btn('goCalendar', '📅', '달력', calClr) +
      btn('goStats', '📊', '통계', statsClr) +
      '</div>';
  }

  function inputOverlay() {
    var hasTranslated = state.translatedPairs !== null;
    var h = '<div style="position:fixed; top:0; bottom:0; width:100%; max-width:430px; left:50%; transform:translateX(-50%); background:#F5F3FF; z-index:50; display:flex; flex-direction:column; animation:fadeUp 0.2s ease;">';
    h += '<div style="background:white; padding:14px 20px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #E5E7EB; flex-shrink:0;">' +
      '<button data-action="closeInput" style="width:36px; height:36px; border-radius:10px; background:#F3F4F6; border:none; font-size:18px; cursor:pointer; color:#374151; display:flex; align-items:center; justify-content:center;">✕</button>' +
      '<div style="font-size:17px; font-weight:800; color:#1E1B4B;">오늘의 문장 입력</div>' +
      '</div>';
    h += '<div style="flex:1; overflow-y:auto; padding:16px;">';

    if (!hasTranslated) {
      var btnBg = state.translating ? '#9CA3AF' : '#4F46E5';
      var btnText = state.translating ? '번역 중...' : '✨  번역하기';
      h += '<div style="background:white; border-radius:16px; padding:20px; box-shadow:0 2px 10px rgba(79,70,229,0.07);">' +
        '<div style="font-size:14px; font-weight:700; color:#374151; margin-bottom:4px;">한국어 문장 입력</div>' +
        '<div style="font-size:12px; color:#9CA3AF; margin-bottom:12px;">한 줄에 하나씩, 최대 10개 입력해주세요</div>' +
        '<textarea data-model="koreanText" placeholder="오늘 날씨가 정말 좋다&#10;나는 영어를 매일 공부한다&#10;커피 한 잔 마실까요?" style="width:100%; height:200px; border:1.5px solid #E5E7EB; border-radius:12px; padding:14px; font-size:14px; resize:none; outline:none; color:#1F2937; line-height:1.7; background:#FAFAFA;"></textarea>';
      if (state.inputError) {
        h += '<div style="color:#EF4444; font-size:12px; margin-top:8px; padding:8px 12px; background:#FEF2F2; border-radius:8px;">' + esc(state.inputError) + '</div>';
      }
      h += '<button data-action="doTranslate"' + (state.translating ? ' disabled' : '') + ' style="background:' + btnBg + '; color:white; border:none; padding:15px; border-radius:12px; font-size:15px; font-weight:800; cursor:pointer; width:100%; margin-top:12px; transition:background 0.2s;">' + btnText + '</button>' +
        '</div>';
    } else {
      h += '<div>';
      h += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; padding:0 2px;">' +
        '<div style="font-size:14px; font-weight:800; color:#1E1B4B;">번역 결과 확인</div>' +
        '<button data-action="resetInput" style="font-size:12px; color:#6B7280; background:none; border:1px solid #E5E7EB; padding:6px 12px; border-radius:8px; cursor:pointer;">다시 입력</button>' +
        '</div>';
      state.translatedPairs.forEach(function (pair, i) {
        h += '<div style="background:white; border-radius:14px; padding:14px 16px; margin-bottom:8px; box-shadow:0 1px 6px rgba(79,70,229,0.06);">' +
          '<div style="display:flex; align-items:flex-start; gap:10px;">' +
          '<div style="width:26px; height:26px; background:#EEF2FF; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;">' +
          '<span style="font-size:11px; font-weight:800; color:#4F46E5;">' + (i + 1) + '</span></div>' +
          '<div style="flex:1;">' +
          '<div style="font-size:14px; color:#1E1B4B; font-weight:600; margin-bottom:8px; line-height:1.4;">' + esc(pair.korean) + '</div>' +
          '<input data-model="pairEnglish" data-index="' + i + '" value="' + escAttr(pair.english) + '" placeholder="English translation..." style="width:100%; border:1.5px solid #E5E7EB; border-radius:8px; padding:9px 12px; font-size:13px; color:#374151; outline:none; background:#FAFAFA;">' +
          '</div></div></div>';
      });
      if (state.inputError) {
        h += '<div style="color:#EF4444; font-size:12px; margin-bottom:10px; padding:8px 12px; background:#FEF2F2; border-radius:8px;">' + esc(state.inputError) + '</div>';
      }
      var saveTxt = state.editMode ? '✅ 수정 완료' : '저장하고 학습 시작 →';
      var saveBg = state.editMode ? '#6366F1' : '#10B981';
      h += '<button data-action="doSave" style="background:' + saveBg + '; color:white; border:none; padding:16px; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; width:100%; margin-top:4px;">' + saveTxt + '</button>';
      h += '</div>';
    }

    h += '</div></div>';
    return h;
  }

  function studyOverlay() {
    var sents = state.studySentences;
    var idx = state.studyIndex;
    var curS = sents[idx] || { korean: '', english: '', completed: false };
    var studyProg = sents.length > 0 ? (idx + 1) + ' / ' + sents.length : '';
    var korLen = (curS.korean || '').length;
    var korFontSize = korLen > 20 ? 20 : korLen > 12 ? 22 : 26;
    var showRevealBtn = !state.autoPlaying && !state.showEnglish && !!curS.korean;

    var h = '<div style="position:fixed; top:0; bottom:0; width:100%; max-width:430px; left:50%; transform:translateX(-50%); background:#0F172A; z-index:50; display:flex; flex-direction:column; animation:fadeUp 0.2s ease;">';

    // header
    h += '<div style="padding:16px 20px 10px; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">' +
      '<button data-action="endStudy" style="background:rgba(255,255,255,0.1); border:none; color:rgba(255,255,255,0.8); padding:8px 14px; border-radius:20px; font-size:13px; cursor:pointer; font-weight:600;">← 나가기</button>' +
      '<div style="color:rgba(255,255,255,0.45); font-size:12px; font-weight:500; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center;">' + esc(state.studyTitle) + '</div>' +
      '<div style="background:rgba(255,255,255,0.1); color:white; padding:7px 14px; border-radius:20px; font-size:13px; font-weight:700; white-space:nowrap;">' + studyProg + '</div>' +
      '</div>';

    // dots
    h += '<div style="padding:8px 16px 0; display:flex; flex-wrap:wrap; gap:6px; justify-content:center; flex-shrink:0;">';
    sents.forEach(function (s, i) {
      var bg = i === idx ? '#4F46E5' : s.completed ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)';
      var bdr = i === idx ? '#818CF8' : s.completed ? '#10B981' : 'rgba(255,255,255,0.18)';
      var clr = i === idx ? 'white' : s.completed ? '#6EE7B7' : 'rgba(255,255,255,0.4)';
      h += '<button data-action="dot" data-index="' + i + '" style="width:34px; height:34px; border-radius:10px; border:1.5px solid ' + bdr + '; background:' + bg + '; color:' + clr + '; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.15s;">' + (i + 1) + '</button>';
    });
    h += '</div>';

    // main
    h += '<div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px 28px; text-align:center; overflow:hidden;">';
    h += '<div style="font-size:' + korFontSize + 'px; font-weight:700; color:white; line-height:1.5; animation:fadeUp 0.4s ease; margin-bottom:20px; text-shadow:0 2px 20px rgba(0,0,0,0.5);">' + esc(curS.korean) + '</div>';

    if (state.speakingKorean) {
      h += '<div style="display:flex; gap:4px; align-items:center; margin-bottom:20px; height:32px;">' +
        '<div style="width:3px; height:14px; background:#818CF8; border-radius:2px; animation:pulse 0.7s infinite;"></div>' +
        '<div style="width:3px; height:22px; background:#818CF8; border-radius:2px; animation:pulse 0.7s 0.15s infinite;"></div>' +
        '<div style="width:3px; height:30px; background:#818CF8; border-radius:2px; animation:pulse 0.7s 0.3s infinite;"></div>' +
        '<div style="width:3px; height:22px; background:#818CF8; border-radius:2px; animation:pulse 0.7s 0.45s infinite;"></div>' +
        '<div style="width:3px; height:14px; background:#818CF8; border-radius:2px; animation:pulse 0.7s 0.6s infinite;"></div>' +
        '</div>';
    }

    if (state.showEnglish) {
      h += '<div style="width:100%; border-top:1px solid rgba(255,255,255,0.1); padding-top:22px; animation:fadeUp 0.4s ease;">' +
        '<div style="font-size:20px; color:#A5B4FC; line-height:1.6; font-weight:500;">' + esc(curS.english) + '</div></div>';
    }

    if (showRevealBtn) {
      h += '<button data-action="showEng" style="margin-top:28px; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.2); color:rgba(255,255,255,0.65); padding:13px 32px; border-radius:14px; font-size:14px; font-weight:600; cursor:pointer;">영어 보기</button>';
    }
    h += '</div>';

    // bottom controls
    var completeBtnBg = curS.completed ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.06)';
    var completeBtnBdr = curS.completed ? 'rgba(16,185,129,0.6)' : 'rgba(255,255,255,0.18)';
    var completeBtnClr = curS.completed ? '#6EE7B7' : 'rgba(255,255,255,0.65)';
    var completeBtnTxt = curS.completed ? '✓ 완료됨  (다시 복습)' : '완료 표시하기';
    var prevBtnClr = idx === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.85)';
    var nextBtnClr = idx === sents.length - 1 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.85)';
    var isPlaying = state.autoPlaying || state.autoPlayAll;
    var playBtnTxt = isPlaying ? '■ 정지' : '🔊 반복';
    var playBtnBg = isPlaying ? '#DC2626' : '#4F46E5';
    var allBtnTxt = state.autoPlayAll ? '■ 중단' : '🔁 자동';
    var allBtnBg = state.autoPlayAll ? '#DC2626' : '#7C3AED';
    var engBtnTxt = state.playingEnglish ? '■ 정지' : '🔈 영어만';
    var engBtnBg = state.playingEnglish ? '#DC2626' : '#0F766E';

    h += '<div style="padding:12px 16px 16px; flex-shrink:0; padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));">' +
      '<button data-action="toggleComplete" style="width:100%; padding:12px; border-radius:14px; border:1.5px solid ' + completeBtnBdr + '; background:' + completeBtnBg + '; color:' + completeBtnClr + '; font-size:14px; font-weight:700; cursor:pointer; margin-bottom:8px; transition:all 0.2s;">' + completeBtnTxt + '</button>' +
      '<div style="display:flex; gap:6px;">' +
      '<button data-action="prevS" style="flex:1; padding:13px 0; border-radius:12px; background:rgba(255,255,255,0.07); border:none; color:' + prevBtnClr + '; font-size:22px; cursor:pointer;">‹</button>' +
      '<button data-action="playBtn" style="flex:1.3; padding:13px 0; border-radius:12px; background:' + playBtnBg + '; border:none; color:white; font-size:12px; font-weight:800; cursor:pointer;">' + playBtnTxt + '</button>' +
      '<button data-action="playAllBtn" style="flex:1.3; padding:13px 0; border-radius:12px; background:' + allBtnBg + '; border:none; color:white; font-size:12px; font-weight:800; cursor:pointer;">' + allBtnTxt + '</button>' +
      '<button data-action="playEngBtn" style="flex:1.3; padding:13px 0; border-radius:12px; background:' + engBtnBg + '; border:none; color:white; font-size:12px; font-weight:800; cursor:pointer;">' + engBtnTxt + '</button>' +
      '<button data-action="nextS" style="flex:1; padding:13px 0; border-radius:12px; background:rgba(255,255,255,0.07); border:none; color:' + nextBtnClr + '; font-size:22px; cursor:pointer;">›</button>' +
      '</div></div>';

    h += '</div>';
    return h;
  }

  function settingsOverlay() {
    var hasKey = false;
    try { hasKey = !!(localStorage.getItem(LS_KEY) || ''); } catch (e) {}
    var h = '<div style="position:fixed; top:0; bottom:0; width:100%; max-width:430px; left:50%; transform:translateX(-50%); background:rgba(15,23,42,0.45); z-index:60; display:flex; align-items:flex-end; animation:fadeUp 0.2s ease;">';
    h += '<div style="background:#F5F3FF; width:100%; border-radius:22px 22px 0 0; padding:20px 18px calc(24px + env(safe-area-inset-bottom,0px)); box-shadow:0 -8px 30px rgba(0,0,0,0.25);">';
    h += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">' +
      '<div style="font-size:17px; font-weight:800; color:#1E1B4B;">설정</div>' +
      '<button data-action="closeSettings" style="width:34px; height:34px; border-radius:10px; background:#FFFFFF; border:1px solid #E5E7EB; font-size:16px; cursor:pointer; color:#374151;">✕</button>' +
      '</div>';

    h += '<div style="background:white; border-radius:16px; padding:18px; box-shadow:0 2px 10px rgba(79,70,229,0.07);">' +
      '<div style="font-size:14px; font-weight:700; color:#374151; margin-bottom:4px;">자동 번역 (Anthropic API 키)</div>' +
      '<div style="font-size:12px; color:#9CA3AF; line-height:1.6; margin-bottom:12px;">한국어 문장을 자동으로 영어로 번역하려면 본인의 Anthropic API 키를 입력하세요. 키는 이 기기(브라우저)에만 저장되며 서버로 전송되지 않습니다. 키 없이도 영어를 직접 입력해 학습할 수 있어요.</div>' +
      '<input data-model="apiKey" data-init="1" type="password" placeholder="sk-ant-..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="width:100%; border:1.5px solid #E5E7EB; border-radius:10px; padding:12px 14px; font-size:13px; color:#374151; outline:none; background:#FAFAFA;">' +
      '<div style="font-size:11px; color:' + (hasKey ? '#10B981' : '#9CA3AF') + '; margin-top:8px;">' + (hasKey ? '● 저장된 키가 있습니다' : '○ 저장된 키가 없습니다 (수동 입력 모드)') + '</div>' +
      '<button data-action="saveSettings" style="background:#4F46E5; color:white; border:none; padding:14px; border-radius:12px; font-size:15px; font-weight:800; cursor:pointer; width:100%; margin-top:14px;">저장</button>' +
      '</div>';

    h += '</div></div>';
    return h;
  }

  /* ─────────────────────── Event delegation ────────────────────── */
  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var name = el.getAttribute('data-action');
    var fn = actions[name];
    if (fn) { e.preventDefault(); fn(el); }
  });

  // Keep uncontrolled inputs mirrored into state WITHOUT re-rendering, so the
  // caret never jumps while typing.
  root.addEventListener('input', function (e) {
    var t = e.target;
    var model = t.getAttribute && t.getAttribute('data-model');
    if (model === 'koreanText') {
      state.koreanText = t.value;
    } else if (model === 'pairEnglish' && state.translatedPairs) {
      var idx = +t.getAttribute('data-index');
      if (state.translatedPairs[idx]) state.translatedPairs[idx].english = t.value;
    }
  });

  /* ────────────────────────────── Init ─────────────────────────── */
  function init() {
    state.data = loadData();
    state.today = getTodayStr();
    render();

    var now = new Date();
    if (isLastSun(now)) {
      setTimeout(function () { showToast('🗓 월말 복습의 날! 미완료 문장을 복습하세요'); }, 700);
    } else if (isSat(now)) {
      setTimeout(function () { showToast('📚 토요일 주간 복습의 날입니다!'); }, 700);
    }

    // Pre-load voices; browsers populate them asynchronously.
    if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function') {
      cachedVoices = window.speechSynthesis.getVoices() || [];
      window.speechSynthesis.onvoiceschanged = function () {
        cachedVoices = window.speechSynthesis.getVoices() || [];
      };
    }
  }

  init();
})();
