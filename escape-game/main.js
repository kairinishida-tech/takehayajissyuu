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
 *      renderOrder / renderBlackjack / renderFishing を参考にしてください）
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
  const elapsedTimeEl = document.getElementById("elapsed-time");
  const clearTimeEl = document.getElementById("clear-time");

  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const progressDotsEl = document.getElementById("progress-dots");

  const stageIconEl = document.getElementById("stage-icon");
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

  // ------------------------------------------------------------
  // クリアタイム計測（「はじめる」を押してから全ステージクリアまでの秒数）
  // ------------------------------------------------------------
  let gameStartTime = null;
  let elapsedTimerId = null;

  /** ミリ秒 → 「◯ふん◯びょう」のようなひらがな表記に整形する */
  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes > 0) {
      return `${minutes}ふん${String(seconds).padStart(2, "0")}びょう`;
    }
    return `${seconds}びょう`;
  }

  /** ステージ画面上部のストップウォッチ表示を更新する（m:ss の数字表記） */
  function updateElapsedBadge() {
    if (!elapsedTimeEl || gameStartTime === null) return;
    const totalSec = Math.max(0, Math.floor((Date.now() - gameStartTime) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    elapsedTimeEl.textContent = `⏱ ${m}:${String(s).padStart(2, "0")}`;
  }

  function startGameTimer() {
    gameStartTime = Date.now();
    updateElapsedBadge();
    if (elapsedTimerId) clearInterval(elapsedTimerId);
    elapsedTimerId = setInterval(updateElapsedBadge, 1000);
  }

  function stopGameTimer() {
    if (elapsedTimerId) {
      clearInterval(elapsedTimerId);
      elapsedTimerId = null;
    }
  }

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

  /**
   * type: "quiz" - 選択肢から答える。2つのモードに対応する。
   *   ① シンプル版（既定）：1つタップしたら即座に正誤判定（answerIndexを使う）
   *   ② 複数選択版（stage.multiSelect: true）：正解の数だけタップして選び、
   *      「けってい」ボタンで判定する（correctAnswersを使う。順番は問わない）
   */
  function renderQuiz(stage, container, handleResult) {
    if (stage.multiSelect) {
      renderQuizMultiSelect(stage, container, handleResult);
    } else {
      renderQuizSingle(stage, container, handleResult);
    }
  }

  /** type: "quiz"（シンプル版） - 選択肢から1つタップして答える */
  function renderQuizSingle(stage, container, handleResult) {
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

  /**
   * type: "quiz"（複数選択版） - 正解の数だけタップして選び、「けってい」で判定する。
   * stage.correctAnswers（choicesのインデックス配列）と、選んだ集合が
   * 完全に一致すれば正解（順番は関係ない）。
   */
  function renderQuizMultiSelect(stage, container, handleResult) {
    const grid = document.createElement("div");
    grid.className = "choice-grid";
    const selected = new Set();

    stage.choices.forEach((choiceText, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = choiceText;
      btn.addEventListener("click", () => {
        if (isLocked) return;
        if (selected.has(index)) {
          selected.delete(index);
          btn.classList.remove("is-selected");
        } else {
          selected.add(index);
          btn.classList.add("is-selected");
        }
      });
      grid.appendChild(btn);
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn-primary";
    confirmBtn.textContent = "✅ けってい";
    confirmBtn.addEventListener("click", () => {
      if (isLocked) return;
      const correctSet = new Set(stage.correctAnswers);
      const isCorrect =
        selected.size === correctSet.size &&
        Array.from(selected).every((i) => correctSet.has(i));

      if (isCorrect) {
        Array.from(grid.children).forEach((c, i) => {
          if (correctSet.has(i)) c.classList.add("is-correct");
        });
      } else {
        Array.from(grid.children).forEach((c) => {
          if (c.classList.contains("is-selected")) {
            c.classList.add("is-wrong");
            setTimeout(() => c.classList.remove("is-wrong"), 400);
          }
        });
      }
      handleResult(isCorrect, {
        wrongMessage: "❌ おしい！もういちど えらんでみよう！",
      });
    });

    container.appendChild(grid);
    container.appendChild(confirmBtn);
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
   * type: "order"（リッチ版） - {label, detail, icon} のカードをリスト表示し、
   * 持ち手（☰）を指でなぞって上下にスライドさせて並べ替える
   * （Pointer Eventsを使った自前実装。外部ライブラリ不要）。
   * カードの文字部分をタップすると detail をポップアップ表示する。
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

    const dragHint = document.createElement("p");
    dragHint.className = "order-rich-draghint";
    dragHint.textContent = "☰ を ゆびで なぞって、じゅんばんを いれかえよう";

    const listEl = document.createElement("div");
    listEl.className = "order-rich-list";

    const detailPanel = document.createElement("div");
    detailPanel.className = "hint-panel order-detail-panel";
    detailPanel.hidden = true;
    const detailText = document.createElement("p");
    detailText.className = "hint-text";
    detailPanel.appendChild(detailText);

    /** handle(持ち手)のドラッグで pos番目のカードを並べ替える */
    function attachDrag(handle, row, pos) {
      handle.addEventListener("pointerdown", (e) => {
        if (isLocked) return;
        e.preventDefault();
        const startY = e.clientY;
        const rows = Array.from(listEl.children);
        // ドラッグ中は他のカードの位置は動かさないので、開始時の位置を固定で使う
        const startRects = rows.map((r) => r.getBoundingClientRect());
        const draggedRect = startRects[pos];

        row.classList.add("is-dragging");
        try {
          handle.setPointerCapture(e.pointerId);
        } catch (err) {
          /* setPointerCaptureが使えない環境でも致命的ではないため無視 */
        }

        function onMove(ev) {
          const deltaY = ev.clientY - startY;
          row.style.transform = `translateY(${deltaY}px)`;
        }

        function onUp(ev) {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          row.classList.remove("is-dragging");
          row.style.transform = "";

          const deltaY = ev.clientY - startY;
          const draggedCenter = draggedRect.top + draggedRect.height / 2 + deltaY;

          // 自分以外のカードを元の順番のまま並べ、draggedCenterがどこに
          // 入るかを、各カードの中心Y座標との比較で決める。
          const others = displayOrder.filter((_, idx) => idx !== pos);
          let insertAt = others.length;
          for (let idx = 0; idx < others.length; idx++) {
            const originalPos = idx < pos ? idx : idx + 1;
            const rect = startRects[originalPos];
            const center = rect.top + rect.height / 2;
            if (draggedCenter < center) {
              insertAt = idx;
              break;
            }
          }

          const draggedValue = displayOrder[pos];
          const newOrder = others.slice();
          newOrder.splice(insertAt, 0, draggedValue);
          displayOrder = newOrder;
          renderList();
        }

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      });
    }

    function renderList() {
      listEl.innerHTML = "";
      displayOrder.forEach((originalIndex, pos) => {
        const item = items[originalIndex];

        const row = document.createElement("div");
        row.className = "order-rich-item";

        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "order-rich-handle";
        handle.textContent = "☰";
        handle.setAttribute("aria-label", "ならべかえる（なぞって動かす）");

        const labelBtn = document.createElement("button");
        labelBtn.type = "button";
        labelBtn.className = "order-rich-label";

        if (item.icon) {
          const iconSpan = document.createElement("span");
          iconSpan.className = "order-rich-icon";
          iconSpan.textContent = item.icon;
          iconSpan.setAttribute("aria-hidden", "true");
          labelBtn.appendChild(iconSpan);
        }

        const textSpan = document.createElement("span");
        textSpan.className = "order-rich-text";
        textSpan.textContent = item.label;
        labelBtn.appendChild(textSpan);

        labelBtn.addEventListener("click", () => {
          if (!item.detail) return;
          detailText.textContent = (item.icon ? item.icon + " " : "") + item.detail;
          detailPanel.hidden = false;
        });

        row.appendChild(handle);
        row.appendChild(labelBtn);
        listEl.appendChild(row);

        attachDrag(handle, row, pos);
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

    container.appendChild(dragHint);
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
          setTimeout(step, 400);
          return;
        }
        finishRound();
      }
      setTimeout(step, 400);
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

  /** 魚が同時に画面に出る最大数（多すぎて混乱しないように制限） */
  const FISHING_MAX_CONCURRENT = 4;
  /** 魚を生成しにいく間隔(ms)。実際に出るかはMAX_CONCURRENTの空き次第
   *  ゲーム全体を短時間で遊べるようにするため、やや速いテンポにしてある */
  const FISHING_SPAWN_INTERVAL_MS = 900;
  /** 魚が画面を泳ぎきるのにかける時間の範囲(ms)＝約2.5〜4.5秒（短い制限時間の中で
   *  何度もチャンスが回ってくるよう、読み取れる範囲でやや短めにしてある） */
  const FISHING_MIN_DURATION_MS = 2500;
  const FISHING_MAX_DURATION_MS = 4500;
  /** 池の外に完全に隠れるための余白(px)。魚のだいたいの横幅として使う */
  const FISHING_OFFSCREEN_MARGIN = 160;

  /**
   * type: "fishing" - お題に合う英単語の魚だけをタップして釣り上げるゲーム。
   * 目標数に到達したら handleResult(true) で共通の次ステージ遷移に乗せる。
   * 不正解の魚をタップ／時間切れの場合は「噛まれる」演出のあと、
   * このステージ内だけでカウント・タイマー・魚をリセットしてやり直す。
   */
  function renderFishing(stage, container, handleResult) {
    const targetCatches = stage.targetCatches || 5;
    const timeLimitSec = stage.timeLimitSec || 30;
    const correctWords = stage.correctWords || [];
    const wrongWords = stage.wrongWords || [];

    const wrap = document.createElement("div");
    wrap.className = "fishing-wrap";

    const themeEl = document.createElement("p");
    themeEl.className = "fishing-theme";
    themeEl.textContent = "🎯 " + (stage.themeLabel || "");

    const statusRow = document.createElement("div");
    statusRow.className = "fishing-status";
    const timerEl = document.createElement("span");
    timerEl.className = "fishing-timer";
    const countEl = document.createElement("span");
    countEl.className = "fishing-count";
    statusRow.appendChild(timerEl);
    statusRow.appendChild(countEl);

    const pondOuter = document.createElement("div");
    pondOuter.className = "fishing-pond-outer";
    const pond = document.createElement("div");
    pond.className = "fishing-pond";
    const biteOverlay = document.createElement("div");
    biteOverlay.className = "fishing-bite-overlay";
    biteOverlay.hidden = true;
    const biteText = document.createElement("p");
    biteText.className = "fishing-bite-text";
    biteText.textContent = "🐟💢 いたい！ 小指を かまれた！";
    const biteSub = document.createElement("p");
    biteSub.className = "fishing-bite-sub";
    biteSub.textContent = "もういちど さいしょから ちょうせん！";
    biteOverlay.appendChild(biteText);
    biteOverlay.appendChild(biteSub);
    pondOuter.appendChild(pond);
    pondOuter.appendChild(biteOverlay);

    wrap.appendChild(themeEl);
    wrap.appendChild(statusRow);
    wrap.appendChild(pondOuter);
    container.appendChild(wrap);

    let caught = 0;
    let timeLeft = timeLimitSec;
    let isGameOver = false; // trueの間はタップ判定・出現を止める（結果演出中/リセット中）
    let spawnTimer = null;
    let countdownTimer = null;
    const activeFish = new Set(); // { el, caught, escapeTimer } のSet

    function pickWord() {
      // 短い制限時間の中で確実にチャンスが来るよう、正解をやや多め(65%)に出す
      const useCorrect = correctWords.length > 0 && (Math.random() < 0.65 || wrongWords.length === 0);
      if (useCorrect) {
        return { word: correctWords[randInt(0, correctWords.length - 1)], isCorrect: true };
      }
      return { word: wrongWords[randInt(0, wrongWords.length - 1)], isCorrect: false };
    }

    function updateStatus() {
      timerEl.textContent = `⏱ のこり ${Math.max(timeLeft, 0)}びょう`;
      countEl.textContent = `🐟 ${caught} / ${targetCatches} ひき`;
    }

    function removeFish(record) {
      clearTimeout(record.escapeTimer);
      activeFish.delete(record);
      if (record.el.parentNode) record.el.parentNode.removeChild(record.el);
    }

    function spawnFish() {
      if (isGameOver || activeFish.size >= FISHING_MAX_CONCURRENT) return;

      const pondWidth = pond.clientWidth || 300;
      const pondHeight = pond.clientHeight || 200;
      const { word, isCorrect } = pickWord();
      const fromLeft = Math.random() < 0.5;
      const durationMs =
        FISHING_MIN_DURATION_MS + Math.random() * (FISHING_MAX_DURATION_MS - FISHING_MIN_DURATION_MS);
      const startX = fromLeft ? -FISHING_OFFSCREEN_MARGIN : pondWidth + FISHING_OFFSCREEN_MARGIN;
      const endX = fromLeft ? pondWidth + FISHING_OFFSCREEN_MARGIN : -FISHING_OFFSCREEN_MARGIN;
      const top = Math.random() * Math.max(pondHeight - 56, 0);

      const fishEl = document.createElement("button");
      fishEl.type = "button";
      fishEl.className = "fishing-fish";
      fishEl.textContent = `🐟 ${word}`;
      fishEl.style.top = `${top}px`;
      fishEl.style.left = `${startX}px`;
      pond.appendChild(fishEl);

      // 1フレーム後にtransitionを設定してから位置を変えることで、
      // 確実にアニメーション(泳ぎ)として認識させる
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fishEl.style.transition = `left ${durationMs}ms linear`;
          fishEl.style.left = `${endX}px`;
        });
      });

      const record = { el: fishEl, isCorrect };
      record.escapeTimer = setTimeout(() => {
        removeFish(record); // タップされないまま泳ぎきったら見逃したことになる（ペナルティなし）
      }, durationMs + 100);
      activeFish.add(record);

      fishEl.addEventListener("click", () => {
        if (isGameOver || !activeFish.has(record)) return;
        clearTimeout(record.escapeTimer);
        if (record.isCorrect) {
          onCatchCorrect(record);
        } else {
          onCatchWrong(record);
        }
      });
    }

    function onCatchCorrect(record) {
      record.el.classList.add("is-caught-correct");
      record.el.disabled = true;
      activeFish.delete(record);
      setTimeout(() => {
        if (record.el.parentNode) record.el.parentNode.removeChild(record.el);
      }, 350);

      caught += 1;
      updateStatus();

      if (caught >= targetCatches) {
        winGame();
      }
    }

    function onCatchWrong(record) {
      record.el.classList.add("is-caught-wrong");
      record.el.disabled = true;
      activeFish.delete(record);
      failGame();
    }

    function stopLoops() {
      isGameOver = true;
      if (spawnTimer) clearInterval(spawnTimer);
      if (countdownTimer) clearInterval(countdownTimer);
      spawnTimer = null;
      countdownTimer = null;
      activeFish.forEach((record) => clearTimeout(record.escapeTimer));
    }

    function winGame() {
      stopLoops();
      handleResult(true);
    }

    function failGame() {
      stopLoops();
      biteOverlay.hidden = false;
      if (navigator.vibrate) {
        try {
          navigator.vibrate(200);
        } catch (e) {
          /* 対応していない端末では無視 */
        }
      }
      setTimeout(() => {
        biteOverlay.hidden = true;
        startGame();
      }, 1500);
    }

    function startGame() {
      isGameOver = false;
      caught = 0;
      timeLeft = timeLimitSec;
      pond.innerHTML = "";
      activeFish.clear();
      updateStatus();

      spawnFish(); // 開始直後に池が空にならないよう1匹すぐ出す
      spawnTimer = setInterval(spawnFish, FISHING_SPAWN_INTERVAL_MS);
      countdownTimer = setInterval(() => {
        timeLeft -= 1;
        updateStatus();
        if (timeLeft <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          if (caught >= targetCatches) {
            winGame();
          } else {
            failGame();
          }
        }
      }, 1000);
    }

    startGame();
  }

  // type名 → 描画関数 のマップ。新しい type はここに追加するだけ。
  const RENDERERS = {
    quiz: renderQuiz,
    "code-input": renderCodeInput,
    order: renderOrder,
    blackjack: renderBlackjack,
    fishing: renderFishing,
  };

  // ------------------------------------------------------------
  // ステージ表示・進行
  // ------------------------------------------------------------

  /** type名 → 進捗ドット・ステージヘッダーに使うアイコン。未対応typeは🧩でフォールバック */
  const STAGE_TYPE_ICONS = {
    quiz: "🧠",
    "code-input": "⌨️",
    order: "🔧",
    blackjack: "🃏",
    fishing: "🎣",
  };

  function iconForStage(stage) {
    return (stage && STAGE_TYPE_ICONS[stage.type]) || "🧩";
  }

  /** ステージ数ぶんの進捗ドットを1回だけ作る（すごろく風に現在地がわかる） */
  function buildProgressDots() {
    if (!progressDotsEl) return;
    progressDotsEl.innerHTML = "";
    STAGES.forEach((stage) => {
      const dot = document.createElement("span");
      dot.className = "progress-dot";
      dot.textContent = iconForStage(stage);
      progressDotsEl.appendChild(dot);
    });
  }

  function updateProgress() {
    const total = STAGES.length;
    const current = currentStageIndex + 1;
    progressLabel.textContent = `${current} / ${total}`;
    progressFill.style.width = `${(currentStageIndex / total) * 100}%`;

    if (progressDotsEl) {
      Array.from(progressDotsEl.children).forEach((dot, i) => {
        dot.classList.toggle("is-done", i < currentStageIndex);
        dot.classList.toggle("is-current", i === currentStageIndex);
      });
    }
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

    if (stageIconEl) stageIconEl.textContent = iconForStage(stage);
    stageTitleEl.textContent = stage.title;
    stagePromptEl.textContent = stage.prompt || "";

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

    const colors = [
      "#ff8a3d", "#4dc3a3", "#6f7bf7", "#ffd93d", "#ff5a5f",
      "#ff8ac6", "#35c165", "#ffd166",
    ];
    const pieces = Array.from({ length: 110 }, () => ({
      x: Math.random() * canvas.width,
      y: -Math.random() * canvas.height,
      size: 6 + Math.random() * 9,
      speedY: (2 + Math.random() * 3) * window.devicePixelRatio,
      speedX: (Math.random() - 0.5) * 2 * window.devicePixelRatio,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() < 0.3 ? "circle" : "rect",
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
        if (p.shape === "circle") {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        }
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
    stopGameTimer();
    if (clearTimeEl) {
      const elapsedMs = gameStartTime !== null ? Date.now() - gameStartTime : 0;
      clearTimeEl.textContent = `🕒 クリアタイム：${formatElapsed(elapsedMs)}`;
    }
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
    stopGameTimer();
    gameStartTime = null;
    currentStageIndex = 0;
    saveProgress();
    showScreen("title");
  }

  // ------------------------------------------------------------
  // イベント登録
  // ------------------------------------------------------------
  btnStart.addEventListener("click", () => {
    startGameTimer();
    loadStage(0);
  });
  btnHint.addEventListener("click", showHint);
  btnReveal.addEventListener("click", revealPhoto);
  btnRestart.addEventListener("click", restartGame);

  // 初期表示（リロード時に途中から再開したい場合はここで復元）
  buildProgressDots();
  currentStageIndex = loadProgress();
  showScreen("title");
})();
