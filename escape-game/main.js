/**
 * main.js
 * ---------------------------------------------------------------
 * 画面遷移・正誤判定・演出などの「共通ロジック」をまとめたファイル。
 * ステージの中身（問題文・選択肢・正解など）は一切ここに書かず、
 * すべて stages.js から読み込んで汎用的に処理します。
 *
 * ▼ 出題形式(type)を新しく増やしたいとき
 *   1. stages.js に新しい type のステージを追加する
 *   2. このファイルの RENDERERS に「type名: 描画関数」を1行追加する
 *   3. 描画関数を1つ実装する（下の renderQuiz / renderCodeInput /
 *      renderOrder を参考にしてください）
 *      描画関数は (stage, container, handleResult) を受け取り、
 *      正解/不正解が決まったタイミングで handleResult(true/false)
 *      を呼び出すだけでOK。あとは共通ロジックが進行を管理します。
 * ---------------------------------------------------------------
 */

(function () {
  "use strict";

  const STAGES = window.STAGES || [];
  const SESSION_KEY = "escapeGame.currentStageIndex";

  // ------------------------------------------------------------
  // DOM参照
  // ------------------------------------------------------------
  const screens = {
    title: document.getElementById("screen-title"),
    stage: document.getElementById("screen-stage"),
    clear: document.getElementById("screen-clear"),
  };

  const btnStart = document.getElementById("btn-start");
  const btnHint = document.getElementById("btn-hint");
  const btnReveal = document.getElementById("btn-reveal");
  const btnRestart = document.getElementById("btn-restart");

  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");

  const stageTitleEl = document.getElementById("stage-title");
  const stagePromptEl = document.getElementById("stage-prompt");
  const stageImageEl = document.getElementById("stage-image");
  const stageBodyEl = document.getElementById("stage-body");
  const feedbackEl = document.getElementById("feedback");
  const hintPanel = document.getElementById("hint-panel");
  const hintText = document.getElementById("hint-text");

  const photoWrap = document.getElementById("photo-wrap");
  const finalPhotoEl = document.getElementById("final-photo");
  const photoFallbackEl = document.getElementById("photo-fallback");

  // ------------------------------------------------------------
  // 状態管理（共有iPad想定なのでメモリ上の変数がメイン。
  // 途中リロード対策として sessionStorage にも保存する）
  // ------------------------------------------------------------
  let currentStageIndex = 0;
  let isLocked = false; // 正解演出中などの二重タップ防止

  function saveProgress() {
    try {
      sessionStorage.setItem(SESSION_KEY, String(currentStageIndex));
    } catch (e) {
      /* sessionStorageが使えない環境でも動作に支障はないため無視 */
    }
  }

  function loadProgress() {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved !== null) {
        const n = parseInt(saved, 10);
        if (!Number.isNaN(n) && n >= 0 && n < STAGES.length) {
          return n;
        }
      }
    } catch (e) {
      /* 無視 */
    }
    return 0;
  }

  // ------------------------------------------------------------
  // 画面切り替え
  // ------------------------------------------------------------
  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      screens[key].classList.toggle("is-active", key === name);
    });
  }

  // ------------------------------------------------------------
  // 出題形式ごとの描画・判定ロジック
  // ------------------------------------------------------------

  /** 全角の英数字を半角に、ひらがな以外の余計な空白を除去して緩めに正規化する */
  function normalizeAnswer(str) {
    return String(str)
      .trim()
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
      )
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  /** type: "quiz" - 選択肢から1つタップして答える */
  function renderQuiz(stage, container, handleResult) {
    const grid = document.createElement("div");
    grid.className = "choice-grid";

    stage.choices.forEach((choiceText, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = choiceText;
      btn.addEventListener("click", () => {
        if (isLocked) return;
        const isCorrect = index === stage.answerIndex;
        if (isCorrect) {
          btn.classList.add("is-correct");
          Array.from(grid.children).forEach((c) => c.classList.add("is-disabled"));
        } else {
          btn.classList.add("is-wrong");
          setTimeout(() => btn.classList.remove("is-wrong"), 400);
        }
        handleResult(isCorrect);
      });
      grid.appendChild(btn);
    });

    container.appendChild(grid);
  }

  /** type: "code-input" - キーボードで答えを入力する */
  function renderCodeInput(stage, container, handleResult) {
    const row = document.createElement("div");
    row.className = "code-input-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "code-input-field";
    input.placeholder = stage.placeholder || "こたえを にゅうりょく";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.setAttribute("autocorrect", "off");
    input.setAttribute("inputmode", "text");

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn btn-primary";
    submitBtn.textContent = "けってい";

    function submit() {
      if (isLocked) return;
      const isCorrect = normalizeAnswer(input.value) === normalizeAnswer(stage.answer);
      if (isCorrect) {
        input.classList.remove("is-wrong");
      } else {
        input.classList.add("is-wrong");
        setTimeout(() => input.classList.remove("is-wrong"), 400);
      }
      handleResult(isCorrect);
    }

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    row.appendChild(input);
    row.appendChild(submitBtn);
    container.appendChild(row);
  }

  /** type: "order" - ピースを正しい順番でタップしていく */
  function renderOrder(stage, container, handleResult) {
    const pieceRow = document.createElement("div");
    pieceRow.className = "order-piece-row";

    const answerRow = document.createElement("div");
    answerRow.className = "order-answer-row";

    const total = stage.correctOrder.length;
    for (let i = 0; i < total; i++) {
      const slot = document.createElement("div");
      slot.className = "order-answer-slot";
      answerRow.appendChild(slot);
    }

    let pickedOrder = []; // items配列でのインデックスを、タップした順に格納

    function reset() {
      pickedOrder = [];
      Array.from(pieceRow.children).forEach((el) => el.classList.remove("is-picked"));
      Array.from(answerRow.children).forEach((el) => (el.textContent = ""));
    }

    stage.items.forEach((label, index) => {
      const piece = document.createElement("button");
      piece.type = "button";
      piece.className = "order-piece";
      piece.textContent = label;
      piece.addEventListener("click", () => {
        if (isLocked || piece.classList.contains("is-picked")) return;
        piece.classList.add("is-picked");
        pickedOrder.push(index);
        answerRow.children[pickedOrder.length - 1].textContent = label;

        if (pickedOrder.length === total) {
          const isCorrect = stage.correctOrder.every((v, i) => v === pickedOrder[i]);
          if (!isCorrect) {
            answerRow.classList.add("choice-btn", "is-wrong"); // 揺れアニメーション流用
            setTimeout(() => {
              answerRow.classList.remove("choice-btn", "is-wrong");
              reset();
            }, 500);
          }
          handleResult(isCorrect);
        }
      });
      pieceRow.appendChild(piece);
    });

    container.appendChild(pieceRow);
    container.appendChild(answerRow);
  }

  // type名 → 描画関数 のマップ。新しい type はここに追加するだけ。
  const RENDERERS = {
    quiz: renderQuiz,
    "code-input": renderCodeInput,
    order: renderOrder,
  };

  // ------------------------------------------------------------
  // ステージ表示・進行
  // ------------------------------------------------------------
  function updateProgress() {
    const total = STAGES.length;
    const current = currentStageIndex + 1;
    progressLabel.textContent = `${current} / ${total}`;
    progressFill.style.width = `${(currentStageIndex / total) * 100}%`;
  }

  function loadStage(index) {
    const stage = STAGES[index];
    if (!stage) {
      finishGame();
      return;
    }

    isLocked = false;
    currentStageIndex = index;
    saveProgress();
    updateProgress();

    stageTitleEl.textContent = stage.title;
    stagePromptEl.textContent = stage.prompt;

    if (stage.image) {
      stageImageEl.src = stage.image;
      stageImageEl.hidden = false;
    } else {
      stageImageEl.hidden = true;
      stageImageEl.removeAttribute("src");
    }

    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
    hintPanel.hidden = true;
    hintText.textContent = stage.hint || "";

    stageBodyEl.innerHTML = "";
    const renderer = RENDERERS[stage.type];
    if (!renderer) {
      // 未対応のtypeが指定された場合の開発者向けフォールバック
      const warn = document.createElement("p");
      warn.textContent = `⚠️ 未対応の type です: "${stage.type}"（main.js の RENDERERS に追加してください）`;
      stageBodyEl.appendChild(warn);
      return;
    }

    renderer(stage, stageBodyEl, (isCorrect) => handleResult(stage, isCorrect));

    showScreen("stage");
  }

  function handleResult(stage, isCorrect) {
    if (isCorrect) {
      isLocked = true;
      feedbackEl.textContent = "🎉 せいかい！";
      feedbackEl.className = "feedback is-correct";
      setTimeout(() => {
        loadStage(currentStageIndex + 1);
      }, 900);
    } else {
      feedbackEl.textContent = "❌ ざんねん、もういちど ちょうせん！";
      feedbackEl.className = "feedback is-wrong";
    }
  }

  function showHint() {
    hintPanel.hidden = !hintPanel.hidden;
  }

  // ------------------------------------------------------------
  // クリア演出（紙吹雪）
  // 外部ライブラリなしで動く、軽量な自前のcanvas紙吹雪アニメーション。
  // ------------------------------------------------------------
  function runConfetti() {
    const canvas = document.getElementById("confetti-canvas");
    if (!canvas || !canvas.getContext) return () => {};
    const ctx = canvas.getContext("2d");

    function resize() {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    }
    resize();
    window.addEventListener("resize", resize);

    const colors = ["#ff8a3d", "#4dc3a3", "#6f7bf7", "#ffd93d", "#ff5a5f"];
    const pieces = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width,
      y: -Math.random() * canvas.height,
      size: 6 + Math.random() * 8,
      speedY: (2 + Math.random() * 3) * window.devicePixelRatio,
      speedX: (Math.random() - 0.5) * 2 * window.devicePixelRatio,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));

    let rafId;
    let running = true;

    function frame() {
      if (!running) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((p) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.rotation += p.rotationSpeed;
        if (p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      rafId = requestAnimationFrame(frame);
    }
    frame();

    return function stop() {
      running = false;
      window.removeEventListener("resize", resize);
      if (rafId) cancelAnimationFrame(rafId);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }

  let stopConfetti = null;

  // ------------------------------------------------------------
  // 最終写真の表示
  // assets/final-photo.jpg → assets/final-photo.png の順に探し、
  // どちらも見つからなければ開発者向けフォールバック表示にする。
  // ------------------------------------------------------------
  function loadFinalPhoto() {
    const candidates = ["assets/final-photo.jpg", "assets/final-photo.png"];
    let i = 0;

    photoFallbackEl.hidden = true;
    finalPhotoEl.hidden = false;

    function tryNext() {
      if (i >= candidates.length) {
        finalPhotoEl.hidden = true;
        photoFallbackEl.hidden = false;
        return;
      }
      finalPhotoEl.src = candidates[i];
      i += 1;
    }

    finalPhotoEl.onerror = tryNext;
    finalPhotoEl.onload = () => {
      photoFallbackEl.hidden = true;
      finalPhotoEl.hidden = false;
    };
    tryNext();
  }

  function finishGame() {
    showScreen("clear");
    photoWrap.hidden = true;
    btnReveal.hidden = false;
    btnRestart.hidden = true;
    if (stopConfetti) stopConfetti();
    stopConfetti = runConfetti();
  }

  function revealPhoto() {
    btnReveal.hidden = true;
    photoWrap.hidden = false;
    btnRestart.hidden = false;
    loadFinalPhoto();
  }

  function restartGame() {
    if (stopConfetti) {
      stopConfetti();
      stopConfetti = null;
    }
    currentStageIndex = 0;
    saveProgress();
    showScreen("title");
  }

  // ------------------------------------------------------------
  // イベント登録
  // ------------------------------------------------------------
  btnStart.addEventListener("click", () => {
    loadStage(0);
  });
  btnHint.addEventListener("click", showHint);
  btnReveal.addEventListener("click", revealPhoto);
  btnRestart.addEventListener("click", restartGame);

  // 初期表示（リロード時に途中から再開したい場合はここで復元）
  currentStageIndex = loadProgress();
  showScreen("title");
})();
