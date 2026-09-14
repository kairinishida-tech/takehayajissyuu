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
 *      renderOrder / renderBlackjack を参考にしてください）
 *      描画関数は (stage, container, handleResult, advanceStage) を受け取ります。
 *        - container に自分のUIを組み立てて追加する
 *        - 正解/不正解が決まったタイミングで handleResult(isCorrect, options) を呼ぶ
 *          （options.wrongMessage / options.correctMessage で
 *            共通フィードバック欄の文言を上書きできる。省略時はデフォルト文言）
 *          → handleResult(true, ...) を呼ぶと、共通のフィードバック演出のあと
 *            自動で次のステージに進みます
 *        - ブラックジャックのように「結果画面に自前のボタンを出して、
 *          押されたタイミングで次に進みたい」場合は、共通フィードバックを
 *          経由せずに advanceStage() を直接呼んでもOKです
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

  /**
   * type: "order" のディスパッチャー。
   * items が文字列の配列なら renderOrderSimple（タップして並べる形式）、
   * items が {label, detail} のオブジェクトの配列なら renderOrderRich
   * （リスト並べ替え＋詳細ポップアップ形式）に振り分ける。
   */
  function renderOrder(stage, container, handleResult) {
    const items = stage.items || [];
    const isRich = items.length > 0 && typeof items[0] === "object";
    if (isRich) {
      renderOrderRich(stage, container, handleResult);
    } else {
      renderOrderSimple(stage, container, handleResult);
    }
  }

  /** type: "order"（シンプル版） - ピースを正しい順番でタップしていく */
  function renderOrderSimple(stage, container, handleResult) {
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

  /** 配列をシャッフルしたコピーを返す（Fisher-Yates） */
  function shuffleArray(source) {
    const arr = source.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * type: "order"（リッチ版） - {label, detail} のカードをリスト表示し、
   * ▲▼ボタンで並べ替える。カードをタップすると detail をポップアップ表示する。
   * items は「正解の順番」で書かれている前提（correctOrderを省略した場合は
   * items のインデックス順 [0,1,2,...] がそのまま正解になる）。
   * 表示は必ずシャッフルした状態から始める。
   */
  function renderOrderRich(stage, container, handleResult) {
    const items = stage.items;
    const correctOrder = Array.isArray(stage.correctOrder)
      ? stage.correctOrder
      : items.map((_, i) => i);

    // シャッフルして表示用の並び(items配列でのインデックス列)を作る。
    // 万が一シャッフル結果がそのまま正解と一致したら振り直す。
    let displayOrder = shuffleArray(correctOrder);
    if (items.length > 1) {
      let guard = 0;
      while (
        displayOrder.every((v, i) => v === correctOrder[i]) &&
        guard < 10
      ) {
        displayOrder = shuffleArray(correctOrder);
        guard += 1;
      }
    }

    const listEl = document.createElement("div");
    listEl.className = "order-rich-list";

    const detailPanel = document.createElement("div");
    detailPanel.className = "hint-panel order-detail-panel";
    detailPanel.hidden = true;
    const detailText = document.createElement("p");
    detailText.className = "hint-text";
    detailPanel.appendChild(detailText);

    function renderList() {
      listEl.innerHTML = "";
      displayOrder.forEach((originalIndex, pos) => {
        const item = items[originalIndex];

        const row = document.createElement("div");
        row.className = "order-rich-item";

        const labelBtn = document.createElement("button");
        labelBtn.type = "button";
        labelBtn.className = "order-rich-label";
        labelBtn.textContent = item.label;
        labelBtn.addEventListener("click", () => {
          if (!item.detail) return;
          detailText.textContent = item.detail;
          detailPanel.hidden = false;
        });

        const controls = document.createElement("div");
        controls.className = "order-rich-controls";

        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "order-rich-btn";
        upBtn.textContent = "▲";
        upBtn.setAttribute("aria-label", "上へ");
        upBtn.disabled = pos === 0;
        upBtn.addEventListener("click", () => {
          if (pos === 0) return;
          [displayOrder[pos - 1], displayOrder[pos]] = [
            displayOrder[pos],
            displayOrder[pos - 1],
          ];
          renderList();
        });

        const downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "order-rich-btn";
        downBtn.textContent = "▼";
        downBtn.setAttribute("aria-label", "下へ");
        downBtn.disabled = pos === displayOrder.length - 1;
        downBtn.addEventListener("click", () => {
          if (pos === displayOrder.length - 1) return;
          [displayOrder[pos], displayOrder[pos + 1]] = [
            displayOrder[pos + 1],
            displayOrder[pos],
          ];
          renderList();
        });

        controls.appendChild(upBtn);
        controls.appendChild(downBtn);
        row.appendChild(labelBtn);
        row.appendChild(controls);
        listEl.appendChild(row);
      });
    }

    renderList();

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "btn btn-primary";
    checkBtn.textContent = "✅ これでかくにん";
    checkBtn.addEventListener("click", () => {
      if (isLocked) return;
      const isCorrect = displayOrder.every((v, i) => v === correctOrder[i]);
      handleResult(isCorrect, {
        wrongMessage: "❌ ここが ちがうかも…もういちど ならべかえてみよう！",
      });
    });

    container.appendChild(listEl);
    container.appendChild(detailPanel);
    container.appendChild(checkBtn);
  }

  /** ブラックジャックのルール既定値（stage.rules で上書き可能） */
  const BLACKJACK_DEFAULT_RULES = {
    maxTotal: 21,
    dealerStandsAt: 17,
    cardMin: 1,
    cardMax: 10,
  };

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * type: "blackjack" - コンピュータとの数字ブラックジャック対戦。
   * プレイヤーが勝ったら advanceStage() を直接呼んで次のステージへ、
   * 負け・引き分けの場合は手札をリセットして同じステージ内でやり直せる。
   */
  function renderBlackjack(stage, container, handleResult, advanceStage) {
    const rules = Object.assign({}, BLACKJACK_DEFAULT_RULES, stage.rules || {});

    const cpuSection = document.createElement("div");
    cpuSection.className = "bj-section";
    const cpuHeading = document.createElement("p");
    cpuHeading.className = "bj-heading";
    cpuHeading.textContent = "🖥 コンピュータ";
    const cpuHand = document.createElement("div");
    cpuHand.className = "bj-hand";
    const cpuTotalEl = document.createElement("p");
    cpuTotalEl.className = "bj-total";
    cpuSection.appendChild(cpuHeading);
    cpuSection.appendChild(cpuHand);
    cpuSection.appendChild(cpuTotalEl);

    const playerSection = document.createElement("div");
    playerSection.className = "bj-section";
    const playerHeading = document.createElement("p");
    playerHeading.className = "bj-heading";
    playerHeading.textContent = "🧑 あなた";
    const playerHand = document.createElement("div");
    playerHand.className = "bj-hand";
    const playerTotalEl = document.createElement("p");
    playerTotalEl.className = "bj-total";
    playerSection.appendChild(playerHeading);
    playerSection.appendChild(playerHand);
    playerSection.appendChild(playerTotalEl);

    const actions = document.createElement("div");
    actions.className = "bj-actions";
    const hitBtn = document.createElement("button");
    hitBtn.type = "button";
    hitBtn.className = "btn btn-primary";
    hitBtn.textContent = "🂠 ひく";
    const standBtn = document.createElement("button");
    standBtn.type = "button";
    standBtn.className = "btn btn-secondary";
    standBtn.textContent = "✋ ステイ";
    actions.appendChild(hitBtn);
    actions.appendChild(standBtn);

    const resultEl = document.createElement("div");
    resultEl.className = "bj-result";
    resultEl.hidden = true;

    container.appendChild(cpuSection);
    container.appendChild(playerSection);
    container.appendChild(actions);
    container.appendChild(resultEl);

    let playerCards = [];
    let cpuCards = [];
    let cpuHidden = true; // trueの間、コンピュータの2枚目以降を伏せて表示する
    let phase = "player"; // "player" | "cpu" | "done"

    function total(cards) {
      return cards.reduce((sum, c) => sum + c, 0);
    }

    function renderCard(el, value, faceDown) {
      const card = document.createElement("div");
      card.className = "bj-card" + (faceDown ? " bj-card-back" : "");
      card.textContent = faceDown ? "？" : String(value);
      el.appendChild(card);
    }

    function renderHands() {
      cpuHand.innerHTML = "";
      cpuCards.forEach((v, i) => {
        renderCard(cpuHand, v, cpuHidden && i > 0);
      });
      cpuTotalEl.textContent = cpuHidden
        ? `ごうけい: ${cpuCards[0]} + ？`
        : `ごうけい: ${total(cpuCards)}`;

      playerHand.innerHTML = "";
      playerCards.forEach((v) => renderCard(playerHand, v, false));
      playerTotalEl.textContent = `ごうけい: ${total(playerCards)}`;
    }

    function setActionsEnabled(enabled) {
      hitBtn.disabled = !enabled;
      standBtn.disabled = !enabled;
    }

    function dealInitial() {
      playerCards = [
        randInt(rules.cardMin, rules.cardMax),
        randInt(rules.cardMin, rules.cardMax),
      ];
      cpuCards = [
        randInt(rules.cardMin, rules.cardMax),
        randInt(rules.cardMin, rules.cardMax),
      ];
      cpuHidden = true;
      phase = "player";
      resultEl.hidden = true;
      resultEl.innerHTML = "";
      setActionsEnabled(true);
      renderHands();
    }

    function endRound(playerWon, message) {
      phase = "done";
      setActionsEnabled(false);

      const msg = document.createElement("p");
      msg.className = "bj-result-text " + (playerWon ? "is-correct" : "is-wrong");
      msg.textContent = message;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn " + (playerWon ? "btn-primary" : "btn-secondary");
      btn.textContent = playerWon ? "▶ つぎへ" : "🔁 もういちど";
      btn.addEventListener("click", () => {
        if (playerWon) {
          advanceStage();
        } else {
          dealInitial();
        }
      });

      resultEl.innerHTML = "";
      resultEl.appendChild(msg);
      resultEl.appendChild(btn);
      resultEl.hidden = false;
    }

    function finishRound() {
      const playerTotal = total(playerCards);
      const cpuTotal = total(cpuCards);

      if (cpuTotal > rules.maxTotal) {
        endRound(true, `🎉 コンピュータがバースト！(${cpuTotal}) かち！つぎへすすめる`);
      } else if (playerTotal > cpuTotal) {
        endRound(true, `🎉 ${playerTotal} たい ${cpuTotal} で かち！つぎへすすめる`);
      } else if (playerTotal === cpuTotal) {
        endRound(false, `😢 ${playerTotal} たい ${cpuTotal} で ひきわけ…ざんねん、もういちど`);
      } else {
        endRound(false, `😢 ${playerTotal} たい ${cpuTotal} で まけ…ざんねん、もういちど`);
      }
    }

    function cpuTurn() {
      phase = "cpu";
      cpuHidden = false;
      setActionsEnabled(false);
      renderHands();

      function step() {
        if (total(cpuCards) < rules.dealerStandsAt) {
          cpuCards.push(randInt(rules.cardMin, rules.cardMax));
          renderHands();
          setTimeout(step, 600);
          return;
        }
        finishRound();
      }
      setTimeout(step, 600);
    }

    function playerBust() {
      cpuHidden = false;
      renderHands();
      endRound(false, `💥 バースト！(${total(playerCards)}) ざんねん…もういちど`);
    }

    hitBtn.addEventListener("click", () => {
      if (phase !== "player") return;
      playerCards.push(randInt(rules.cardMin, rules.cardMax));
      renderHands();
      if (total(playerCards) > rules.maxTotal) {
        playerBust();
      }
    });

    standBtn.addEventListener("click", () => {
      if (phase !== "player") return;
      cpuTurn();
    });

    dealInitial();
  }

  // type名 → 描画関数 のマップ。新しい type はここに追加するだけ。
  const RENDERERS = {
    quiz: renderQuiz,
    "code-input": renderCodeInput,
    order: renderOrder,
    blackjack: renderBlackjack,
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

    renderer(
      stage,
      stageBodyEl,
      (isCorrect, options) => handleResult(stage, isCorrect, options),
      advanceStage
    );

    showScreen("stage");
  }

  /** 次のステージへ進む（すべて終わっていればクリア画面へ） */
  function advanceStage() {
    loadStage(currentStageIndex + 1);
  }

  function handleResult(stage, isCorrect, options) {
    const opts = options || {};
    if (isCorrect) {
      isLocked = true;
      feedbackEl.textContent = opts.correctMessage || "🎉 せいかい！";
      feedbackEl.className = "feedback is-correct";
      setTimeout(() => {
        advanceStage();
      }, 900);
    } else {
      feedbackEl.textContent = opts.wrongMessage || "❌ ざんねん、もういちど ちょうせん！";
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
