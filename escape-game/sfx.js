/**
 * sfx.js
 * ---------------------------------------------------------------
 * ゲーム内の効果音をまとめたファイル。
 * 音声ファイルは一切使わず、Web Audio API でその場に音を合成して
 * 鳴らしている（オフラインでも動く・著作権の心配もない）。
 *
 * 使い方: window.SFX.correct() のように呼ぶだけ。
 * ミュート状態は localStorage に保存され、次回訪問時も引き継がれる。
 * ---------------------------------------------------------------
 */

(function () {
  "use strict";

  const MUTE_KEY = "escapeGame.muted";
  let ctx = null;
  let muted = false;

  try {
    muted = localStorage.getItem(MUTE_KEY) === "1";
  } catch (e) {
    /* localStorageが使えない環境でも動作に支障はないため無視 */
  }

  function getContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  /** 1音を鳴らす。freqEndを指定すると音程が滑らかに変化する（サイレン/上昇音等） */
  function tone(opts) {
    if (muted) return;
    const c = getContext();
    if (!c) return;
    const {
      freq = 440,
      freqEnd = null,
      type = "sine",
      startTime = 0,
      duration = 0.15,
      volume = 0.16,
      attack = 0.005,
      release = 0.08,
    } = opts;

    const t0 = c.currentTime + startTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      osc.frequency.linearRampToValueAtTime(freqEnd, t0 + duration);
    }
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + attack);
    gain.gain.linearRampToValueAtTime(0, t0 + duration + release);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + release + 0.02);
  }

  /** notes配列を順番に鳴らす（メロディ・ファンファーレ等） */
  function sequence(notes) {
    if (muted) return;
    let t = 0;
    notes.forEach((note) => {
      tone(Object.assign({}, note, { startTime: t }));
      t += note.gap !== undefined ? note.gap : note.duration || 0.15;
    });
  }

  /** ホワイトノイズの短いバースト（「噛まれた」等の衝撃音に使う） */
  function noiseBurst(opts) {
    if (muted) return;
    const c = getContext();
    if (!c) return;
    const { startTime = 0, duration = 0.2, volume = 0.2, filterFreq = 1200 } = opts || {};
    const t0 = c.currentTime + startTime;
    const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = c.createBufferSource();
    noise.buffer = buffer;

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;

    const gain = c.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    noise.start(t0);
    noise.stop(t0 + duration + 0.02);
  }

  const SFX = {
    /** 最初のユーザー操作（タップ）で呼び、AudioContextをアンロックする（iPad Safari対策） */
    unlock() {
      getContext();
    },

    isMuted() {
      return muted;
    },

    setMuted(value) {
      muted = !!value;
      try {
        localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
      } catch (e) {
        /* 無視 */
      }
    },

    toggleMuted() {
      this.setMuted(!muted);
      return muted;
    },

    /** 軽い操作音（選択肢タップ・並べ替えカードのタップ等） */
    tap() {
      tone({ freq: 720, duration: 0.05, type: "square", volume: 0.09 });
    },

    /** ヒントパネルの開閉 */
    hint() {
      tone({ freq: 500, freqEnd: 700, duration: 0.09, type: "sine", volume: 0.12 });
    },

    /** 正解（ステージ共通のフィードバック） */
    correct() {
      sequence([
        { freq: 523.25, duration: 0.09, type: "triangle", volume: 0.16 },
        { freq: 659.25, duration: 0.09, type: "triangle", volume: 0.16 },
        { freq: 784.0, duration: 0.17, type: "triangle", volume: 0.19 },
      ]);
    },

    /** 不正解（ステージ共通のフィードバック） */
    wrong() {
      tone({ freq: 220, freqEnd: 140, duration: 0.22, type: "sawtooth", volume: 0.14 });
    },

    /** タイトル画面「はじめる」を押したとき。かいじゅうが近づいてくるような低い音 */
    gameStart() {
      sequence([
        { freq: 90, duration: 0.16, type: "sawtooth", volume: 0.15 },
        { freq: 140, duration: 0.14, type: "sawtooth", volume: 0.15 },
        { freq: 80, duration: 0.26, type: "sawtooth", volume: 0.18 },
      ]);
    },

    /** ステージが切り替わるときの短い上昇音 */
    advance() {
      tone({ freq: 440, freqEnd: 880, duration: 0.14, type: "sine", volume: 0.12 });
    },

    /** ブラックジャックでカードを1枚配るとき */
    cardDeal() {
      tone({ freq: 900, duration: 0.03, type: "square", volume: 0.09 });
    },

    /** ブラックジャックで勝ったとき */
    win() {
      sequence([
        { freq: 523.25, duration: 0.1, type: "triangle", volume: 0.16 },
        { freq: 659.25, duration: 0.1, type: "triangle", volume: 0.16 },
        { freq: 784.0, duration: 0.1, type: "triangle", volume: 0.16 },
        { freq: 1046.5, duration: 0.22, type: "triangle", volume: 0.2 },
      ]);
    },

    /** ブラックジャックで負け・引き分け・バーストしたとき */
    lose() {
      sequence([
        { freq: 300, duration: 0.13, type: "sawtooth", volume: 0.14 },
        { freq: 220, duration: 0.13, type: "sawtooth", volume: 0.14 },
        { freq: 150, duration: 0.22, type: "sawtooth", volume: 0.16 },
      ]);
    },

    /** 正しい魚を釣り上げたとき */
    catchFish() {
      tone({ freq: 700, freqEnd: 1100, duration: 0.1, type: "sine", volume: 0.16 });
    },

    /** 違う魚を釣った／時間切れで「噛まれた」とき */
    bite() {
      noiseBurst({ duration: 0.18, volume: 0.22, filterFreq: 900 });
      tone({ freq: 160, freqEnd: 90, duration: 0.16, type: "sawtooth", volume: 0.14, startTime: 0.02 });
    },

    /** 並べ替えカードを持ち上げた／置いたとき */
    pickup() {
      tone({ freq: 380, duration: 0.05, type: "square", volume: 0.08 });
    },
    drop() {
      tone({ freq: 300, duration: 0.06, type: "square", volume: 0.09 });
    },

    /** 全ステージクリア時のファンファーレ */
    fanfare() {
      sequence([
        { freq: 523.25, duration: 0.12, type: "triangle", volume: 0.18 },
        { freq: 659.25, duration: 0.12, type: "triangle", volume: 0.18 },
        { freq: 784.0, duration: 0.12, type: "triangle", volume: 0.18 },
        { freq: 1046.5, duration: 0.12, type: "triangle", volume: 0.2 },
        { freq: 784.0, duration: 0.1, type: "triangle", volume: 0.16, gap: 0.16 },
        { freq: 1046.5, duration: 0.32, type: "triangle", volume: 0.22 },
      ]);
    },

    /** ごほうび写真を開いたときのきらきら音 */
    reveal() {
      sequence([
        { freq: 1046.5, duration: 0.07, type: "sine", volume: 0.12 },
        { freq: 1318.5, duration: 0.07, type: "sine", volume: 0.12 },
        { freq: 1568.0, duration: 0.15, type: "sine", volume: 0.15 },
      ]);
    },
  };

  window.SFX = SFX;
})();
