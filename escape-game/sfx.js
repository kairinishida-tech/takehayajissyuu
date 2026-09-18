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

  /** notes配列を順番に鳴らす（メロディ・ファンファーレ等）。offsetで開始タイミングをずらせる */
  function sequence(notes, offset) {
    if (muted) return;
    let t = offset || 0;
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

  /**
   * かいじゅうの「うなり声」。低音のビブラート付きサウトゥース波＋
   * ローパスノイズを重ねて、地鳴りのような唸りを表現する。
   * ゲーム開始の演出や、ステージ中にたまに鳴る「遠くの咆哮」に使う。
   * 鳴るたびに 'sfx-roar' イベントを発火し、画面の赤いフラッシュ演出と連動させる。
   */
  function growl(opts) {
    const { startTime = 0, duration = 0.9, volume = 0.2 } = opts || {};

    try {
      window.dispatchEvent(new CustomEvent("sfx-roar"));
    } catch (e) {
      /* CustomEventが使えない古い環境でも致命的ではないため無視 */
    }

    if (muted) return;
    const c = getContext();
    if (!c) return;
    const t0 = c.currentTime + startTime;

    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(85, t0);
    osc.frequency.linearRampToValueAtTime(45, t0 + duration);

    // ビブラートで機械的すぎない「唸り」に近づける
    const vibrato = c.createOscillator();
    vibrato.frequency.value = 7;
    const vibratoGain = c.createGain();
    vibratoGain.gain.value = 12;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(osc.frequency);

    const gain = c.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.15);
    gain.gain.linearRampToValueAtTime(volume * 0.7, t0 + duration * 0.6);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    vibrato.start(t0);
    osc.stop(t0 + duration + 0.05);
    vibrato.stop(t0 + duration + 0.05);

    noiseBurst({ startTime, duration, volume: volume * 0.5, filterFreq: 500 });
  }

  // ------------------------------------------------------------
  // アンビエント演出（ステージ中に流す「心臓の鼓動」「遠くの咆哮」）。
  // どちらも低音・低音量のごく控えめな演出で、通常の効果音の邪魔をしない。
  // ------------------------------------------------------------
  let ambientRunning = false;
  let heartbeatTimer = null;
  let roarTimer = null;

  /** 低い二連の鼓動音。鳴るたびに 'sfx-heartbeat' を発火し、画面の小さな揺れと連動させる */
  function heartbeatThump() {
    try {
      window.dispatchEvent(new CustomEvent("sfx-heartbeat"));
    } catch (e) {
      /* 無視 */
    }
    tone({ freq: 58, duration: 0.12, type: "sine", volume: 0.1, attack: 0.008, release: 0.05 });
    tone({ freq: 46, duration: 0.14, type: "sine", volume: 0.08, startTime: 0.16, attack: 0.008, release: 0.06 });
  }

  function scheduleHeartbeat() {
    if (!ambientRunning) return;
    heartbeatThump();
    heartbeatTimer = setTimeout(scheduleHeartbeat, 1600 + Math.random() * 500);
  }

  function scheduleRoar() {
    if (!ambientRunning) return;
    roarTimer = setTimeout(() => {
      if (!ambientRunning) return;
      growl({ duration: 1.1, volume: 0.13 });
      scheduleRoar();
    }, 13000 + Math.random() * 9000);
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
      noiseBurst({ duration: 0.12, volume: 0.09, filterFreq: 500, startTime: 0.02 });
    },

    /**
     * タイトル画面「はじめる」を押したとき。地鳴り→かいじゅうの咆哮→
     * 緊張感が高まる上昇音、という「怪獣映画の予告編」風の3段構成。
     */
    gameStart() {
      tone({ freq: 55, duration: 0.5, type: "sawtooth", volume: 0.17 });
      growl({ startTime: 0.15, duration: 1.1, volume: 0.24 });
      sequence(
        [
          { freq: 100, freqEnd: 200, duration: 0.35, type: "sawtooth", volume: 0.14 },
          { freq: 100, freqEnd: 340, duration: 0.45, type: "sawtooth", volume: 0.16 },
        ],
        1.2
      );
    },

    /** ステージ中に流す、心臓の鼓動と遠くの咆哮のアンビエント演出を開始する */
    startAmbient() {
      if (ambientRunning) return;
      ambientRunning = true;
      scheduleHeartbeat();
      scheduleRoar();
    },

    /** アンビエント演出を止める（クリア画面・タイトルに戻るときに呼ぶ） */
    stopAmbient() {
      ambientRunning = false;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (roarTimer) clearTimeout(roarTimer);
      heartbeatTimer = null;
      roarTimer = null;
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

    /** 全ステージクリア時。かいじゅうを振り切った雄叫び→ファンファーレの2段構成 */
    fanfare() {
      growl({ duration: 0.55, volume: 0.16 });
      sequence(
        [
          { freq: 523.25, duration: 0.12, type: "triangle", volume: 0.18 },
          { freq: 659.25, duration: 0.12, type: "triangle", volume: 0.18 },
          { freq: 784.0, duration: 0.12, type: "triangle", volume: 0.18 },
          { freq: 1046.5, duration: 0.12, type: "triangle", volume: 0.2 },
          { freq: 784.0, duration: 0.1, type: "triangle", volume: 0.16, gap: 0.16 },
          { freq: 1046.5, duration: 0.32, type: "triangle", volume: 0.22 },
        ],
        0.6
      );
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
