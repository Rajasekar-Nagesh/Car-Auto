// Hands-free voice commands (Web Speech API; needs an internet connection
// on most Android devices).

import { $, toast, fmtClock } from '../common.js';

export function parseCommand(text) {
  const t = text.toLowerCase().trim().replace(/[.!?]+$/, '');
  let m;
  if (/^(stop|cancel|end) (the )?(navigation|navigating|route|directions)$/.test(t)) return { cmd: 'stopNav' };
  if ((m = t.match(/^(?:navigate|directions|drive|take me|go|get me|route) (?:to )?(?:the )?(home|work)$/))) return { cmd: 'place', place: m[1] };
  if (/^(go|take me|drive|navigate) home$/.test(t)) return { cmd: 'place', place: 'home' };
  if ((m = t.match(/^(?:navigate to|directions to|take me to|drive to|go to|get me to|find|where is|show me) (.+)$/))) return { cmd: 'navigate', query: m[1] };
  if ((m = t.match(/^(?:call|dial|phone|ring) (.+)$/))) return { cmd: 'call', who: m[1] };
  if (/^(pause|stop)( the)?( music| radio| playback)?$/.test(t)) return { cmd: 'pause' };
  if (/^(next|skip)( song| track| station)?$/.test(t)) return { cmd: 'next' };
  if (/^(previous|back|go back|last)( song| track| station)?$/.test(t)) return { cmd: 'prev' };
  if (/^(volume up|louder|turn it up)$/.test(t)) return { cmd: 'volume', delta: 0.15 };
  if (/^(volume down|quieter|softer|turn it down)$/.test(t)) return { cmd: 'volume', delta: -0.15 };
  if (/^(play|resume)( music| the music| radio| the radio)?$/.test(t)) return { cmd: 'play' };
  if ((m = t.match(/^play (.+?)(?: radio| station)?$/))) return { cmd: 'playSearch', query: m[1] };
  if (/what time is it|what's the time|tell me the time/.test(t)) return { cmd: 'time' };
  if (/how (long|far)|when (will|do) (we|i) arrive|eta/.test(t)) return { cmd: 'eta' };
  if (/^(open |show )?(the )?(map|music|phone|home|settings)$/.test(t)) return { cmd: 'view', view: t.match(/(map|music|phone|home|settings)/)[1] };
  return { cmd: 'unknown', text: t };
}

export function createVoice(ctx) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const overlay = $('#voice-overlay');
  const transcript = $('#voice-transcript');
  let rec = null;

  async function execute(text) {
    const c = parseCommand(text);
    const { nav, music, phone, settings } = ctx;
    switch (c.cmd) {
      case 'navigate': ctx.voice(`Searching for ${c.query}`); return nav.searchAndGo(c.query, { immediate: true });
      case 'place': {
        const p = settings[c.place];
        if (!p) { ctx.voice(`Set your ${c.place} address in settings first.`); return ctx.showView('settings'); }
        return nav.navigateTo({ ...p, name: c.place === 'home' ? 'Home' : 'Work' }, { immediate: true });
      }
      case 'stopNav': nav.stop(); return ctx.voice('Navigation stopped.');
      case 'call': if (!phone.callByName(c.who)) ctx.voice(`I couldn't find ${c.who} in your favorite contacts.`); return;
      case 'pause': return music.pause();
      case 'play': return music.resume();
      case 'next': return music.next();
      case 'prev': return music.prev();
      case 'volume': return music.setVolume(music.getState().volume + c.delta);
      case 'playSearch':
        if (!(await music.playSearch(c.query))) ctx.voice(`I couldn't find ${c.query}.`);
        return;
      case 'time': return ctx.voice(`It's ${fmtClock()}`);
      case 'eta': {
        const s = nav.getState();
        if (!s.active) return ctx.voice('You are not navigating right now.');
        return ctx.voice(`${s.remainingText} to go. You'll arrive at ${fmtClock(new Date(s.eta))}.`);
      }
      case 'view': return ctx.showView(c.view);
      default:
        ctx.voice("Sorry, I didn't get that. Try: navigate to, play, or call.");
    }
  }

  function close() {
    overlay.hidden = true;
    ctx.music.duck(false);
  }

  function listen() {
    if (!SR) {
      toast('Voice commands are not supported in this browser. Use Chrome on Android.', 5000);
      return;
    }
    if (rec) { rec.abort(); return; }
    speechSynthesis?.cancel();
    ctx.music.duck(true);
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    overlay.hidden = false;
    transcript.textContent = 'Listening…';
    rec.onresult = (e) => {
      const r = [...e.results].map((x) => x[0].transcript).join(' ');
      transcript.textContent = r;
      if (e.results[e.results.length - 1].isFinal) finalText = r;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') toast('Microphone permission denied');
      else if (e.error === 'network') toast('Voice commands need an internet connection');
    };
    rec.onend = () => {
      rec = null;
      close();
      if (finalText) execute(finalText);
    };
    try { rec.start(); } catch { rec = null; close(); }
  }

  overlay.addEventListener('click', () => rec?.abort());

  return { listen, execute };
}
