(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const welcome = document.getElementById("welcome-view");
  const dashboard = document.getElementById("dashboard-view");
  const loading = document.getElementById("loading-view");
  const setupError = document.getElementById("setup-error");
  const globalSearch = document.getElementById("global-search");
  const globalSearchWrap = document.getElementById("global-search-wrap");
  const themeModeSelect = document.getElementById("theme-mode-select");
  const darkThemeStylesheet = document.getElementById("dark-theme-stylesheet");
  const themeMetaColor = document.querySelector('meta[name="theme-color"]');
  const messageList = document.getElementById("message-list");
  const emptyState = document.getElementById("empty-state");
  const selectionBar = document.getElementById("selection-bar");
  const accountCard = document.getElementById("account-card");
  const toast = document.getElementById("toast");
  const inboxContent = document.getElementById("inbox-content");
  const reviewContent = document.getElementById("review-content");
  const reviewList = document.getElementById("review-list");
  const reviewEmpty = document.getElementById("review-empty");
  const reviewSelectionBar = document.getElementById("review-selection-bar");
  const autoSortControl = document.getElementById("auto-sort-control");
  const autoSortToggle = document.getElementById("auto-sort-toggle");
  const autoSortStatus = document.getElementById("auto-sort-status");
  let allMessages = [];
  let reviewMessages = [];
  let currentView = "suggested";
  const searchQueries = { suggested: "", all: "", review: "" };
  let keptIds = new Set();
  let selectedIds = new Set();
  let messageLoadGeneration = 0;
  let messageScanPromise = Promise.resolve();
  let reviewLoadGeneration = 0;
  let reviewLoading = false;
  let messageScanInProgress = false;
  let messageScanError = false;
  let autoSortEnabled = false;
  let autoSortBusy = false;
  let messageActionInProgress = false;
  let autoSortTimer;
  let toastTimer;
  let themeAutoTimer;
  let themeMode = window.clearspaceThemeMode || "auto";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  const showToast = (message, isError = false) => {
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3900);
  };

  const updateResolvedTheme = () => {
    const hour = new Date().getHours();
    const isDark = themeMode === "dark" || (themeMode === "auto" && (hour < 7 || hour >= 19));
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    darkThemeStylesheet.disabled = !isDark;
    themeMetaColor.content = isDark ? "#121d19" : "#f6f7f4";
  };

  const setThemeMode = (mode) => {
    if (!["light", "dark", "auto"].includes(mode)) {
      throw new Error("Choose Light, Dark, or Auto for the theme.");
    }
    themeMode = mode;
    window.clearspaceThemeMode = mode;
    themeModeSelect.value = mode;
    clearInterval(themeAutoTimer);
    updateResolvedTheme();
    if (mode === "auto") themeAutoTimer = setInterval(updateResolvedTheme, 60_000);
  };

  setThemeMode(themeMode);

  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
    return body;
  };

  const setViewVisible = (element, visible) => element.classList.toggle("hidden", !visible);

  const activeSearchQuery = () => searchQueries[currentView] || "";

  const updateSearchContext = () => {
    const viewName = currentView === "all" ? "All inbox" : currentView === "review" ? "Review" : "Suggested";
    globalSearch.value = activeSearchQuery();
    globalSearch.placeholder = `Search ${viewName} messages`;
    globalSearch.setAttribute("aria-label", `Search ${viewName} messages`);
  };

  const loadAccount = async () => {
    setupError.classList.add("hidden");
    const params = new URLSearchParams(location.search);
    if (params.has("setup_error")) {
      setupError.textContent = params.get("setup_error");
      setupError.classList.remove("hidden");
      history.replaceState({}, "", location.pathname);
    }
    try {
      const account = await api("/api/account");
      if (!account.connected) {
        globalSearchWrap.hidden = true;
        globalSearch.disabled = true;
        setViewVisible(welcome, true);
        setViewVisible(dashboard, false);
        setViewVisible(loading, false);
        return;
      }
      document.getElementById("account-email").textContent = account.email;
      document.getElementById("account-provider").textContent = account.provider_name;
      document.getElementById("account-avatar").textContent = (account.email || "C").trim().charAt(0).toUpperCase();
      globalSearchWrap.hidden = false;
      globalSearch.disabled = false;
      updateSearchContext();
      accountCard.classList.remove("hidden");
      document.getElementById("clear-learning-button").classList.remove("hidden");
      setViewVisible(welcome, false);
      setViewVisible(loading, true);
      await loadMessages();
      autoSortControl.classList.remove("hidden");
      try {
        const autoSort = await api("/api/auto-sort/status");
        autoSortEnabled = Boolean(autoSort.enabled);
        updateAutoSortControl();
        if (autoSortEnabled) {
          startAutoSortPolling();
          runAutoSortBatch();
        }
      } catch (error) {
        showToast(`Could not load automatic-sorting status. ${error.message}`, true);
      }
    } catch (error) {
      setViewVisible(welcome, false);
      setViewVisible(dashboard, false);
      setViewVisible(loading, false);
      setupError.textContent = `${error.message} Refresh this page to try again.`;
      setupError.classList.remove("hidden");
    }
  };

  const dateLabel = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const days = Math.floor((now - date) / 86400000);
    if (days < 7 && days >= 0) return date.toLocaleDateString([], { weekday: "short" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const renderMessage = (message, index) => {
    const initial = (message.sender || "?").trim().replace(/^.*<([^>]+)>.*$/, "$1").charAt(0);
    const sender = message.sender || "Unknown sender";
    const subject = message.subject || "(no subject)";
    const preview = message.preview || "No preview available.";
    const messageReasons = [...(message.reasons || [])];
    if (currentView === "all" && message.learning_note) messageReasons.push(message.learning_note);
    const reasons = messageReasons.map((reason) => `<span class="reason-pill">${escapeHtml(reason)}</span>`).join("");
    const readIndicator = message.is_read ? "" : '<span class="unread-indicator"></span>';
    const keepButton = currentView === "suggested" && message.suggested
      ? `<button class="button button-outline keep-one" type="button" aria-label="Keep ${escapeHtml(subject)} and learn this sender">Keep</button>` : "";
    return `<article class="message-row" data-id="${escapeHtml(message.id)}">
      <input class="message-check" type="checkbox" aria-label="Select ${escapeHtml(subject)}" ${selectedIds.has(message.id) ? "checked" : ""}>
      <span class="sender-avatar tone-${index % 4}">${escapeHtml(initial || "?")}</span>
      <div class="message-primary">
        <div class="message-sender">${readIndicator}${escapeHtml(sender)}</div>
        <div class="message-subject">${escapeHtml(subject)}</div>
      </div>
      <div class="message-preview">${escapeHtml(preview)}</div>
      <div class="message-meta">${reasons}<span class="message-date">${escapeHtml(dateLabel(message.received_at))}</span></div>
      <div class="message-actions">${keepButton}<button class="button button-outline delete-one" type="button" aria-label="Delete ${escapeHtml(subject)}">Delete</button></div>
    </article>`;
  };

  const visibleMessages = () => {
    const query = activeSearchQuery().trim().toLowerCase();
    return allMessages.filter((message) => {
      if (currentView === "suggested" && (!message.suggested || keptIds.has(message.id))) return false;
      const haystack = [message.sender, message.sender_email, message.subject, message.preview, ...(message.reasons || [])].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    });
  };

  const renderMessages = (addedMessages = null) => {
    setViewVisible(inboxContent, true);
    setViewVisible(reviewContent, false);
    const messages = visibleMessages();
    document.getElementById("suggestion-count").textContent = allMessages.filter((message) => message.suggested && !keptIds.has(message.id)).length;
    document.getElementById("inbox-count").textContent = allMessages.length;
    document.getElementById("nav-count").textContent = allMessages.filter((message) => message.suggested && !keptIds.has(message.id)).length;
    document.getElementById("breadcrumb-current").textContent = currentView === "suggested" ? "Suggested" : "All inbox";
    document.getElementById("list-title").textContent = currentView === "suggested" ? "Worth a second look" : "Your recent inbox";
    document.getElementById("list-description").textContent = currentView === "suggested"
      ? "Keep a sender to reduce future suggestions, or delete to flag that sender."
      : "Browse inbox messages. Delete moves mail immediately to recoverable Trash/Deleted Items.";
    document.getElementById("page-subtitle").textContent = currentView === "suggested"
      ? "A few thoughtful suggestions. You make every call."
      : "Every message, right here. Your inbox, your rules.";
    document.getElementById("page-title").textContent = currentView === "suggested" ? "A calmer inbox starts here." : "A clear view of your inbox.";
    document.getElementById("today-date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    if (addedMessages) {
      const visibleIds = new Set(messages.map((message) => message.id));
      const offset = allMessages.length - addedMessages.length;
      const rows = addedMessages.map((message, index) => (
        visibleIds.has(message.id) ? renderMessage(message, offset + index) : ""
      )).join("");
      messageList.insertAdjacentHTML("beforeend", rows);
    } else {
      messageList.innerHTML = messages.map(renderMessage).join("");
    }
    const hasSuggestions = allMessages.some((message) => message.suggested && !keptIds.has(message.id));
    const isFilteredEmpty = messages.length === 0 && Boolean(activeSearchQuery().trim());
    messageList.classList.toggle("hidden", messages.length === 0);
    emptyState.classList.toggle("hidden", messages.length !== 0);
    selectionBar.classList.toggle("hidden", messages.length === 0);
    document.getElementById("empty-title").textContent = isFilteredEmpty ? "No matches this time." : currentView === "suggested" ? "All clear, all yours." : "Your inbox is empty.";
    document.getElementById("empty-copy").textContent = isFilteredEmpty ? "Try another search, or clear the search box." : currentView === "suggested" && hasSuggestions ? "You’ve kept the remaining suggestions. Nothing will move unless you say so." : "There are no messages to show right now.";
    document.getElementById("empty-switch").classList.toggle("hidden", currentView !== "suggested" || allMessages.length === 0 || !hasSuggestions);
    document.getElementById("last-updated").textContent = allMessages.length ? `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    const inboxProgress = document.getElementById("inbox-progress");
    if (messageScanInProgress) {
      inboxProgress.textContent = `${allMessages.length.toLocaleString()} loaded; fetching the next batch…`;
    } else if (messageScanError) {
      inboxProgress.textContent = `Loading stopped after ${allMessages.length.toLocaleString()}; refresh to retry.`;
    } else {
      inboxProgress.textContent = `${allMessages.length.toLocaleString()} inbox messages loaded.`;
    }
    document.getElementById("select-all").checked = messages.length > 0 && messages.every((message) => selectedIds.has(message.id));
    updateSelectionLabel();
    setViewVisible(dashboard, true);
    setViewVisible(loading, false);
    const refreshButton = document.getElementById("refresh-button");
    refreshButton.hidden = false;
    refreshButton.disabled = messageScanInProgress;
  };

  const renderReview = () => {
    setViewVisible(inboxContent, false);
    setViewVisible(reviewContent, true);
    document.getElementById("breadcrumb-current").textContent = "Clearspace Review";
    document.getElementById("review-progress").textContent = reviewLoading
      ? `${reviewMessages.length.toLocaleString()} loaded; fetching the next batch…`
      : `${reviewMessages.length.toLocaleString()} ${reviewMessages.length === 1 ? "message" : "messages"} loaded.`;
    const query = activeSearchQuery().trim().toLowerCase();
    const matching = visibleReviewMessages();
    const groups = new Map();
    matching.forEach((message) => {
      const key = reviewSenderKey(message);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(message);
    });
    const html = [...groups.entries()]
      .sort((left, right) => right[1].length - left[1].length
        || String(left[1][0].sender || left[0]).localeCompare(String(right[1][0].sender || right[0])))
      .map(([key, messages]) => {
        const sender = messages[0].sender || key;
        const selectedCount = messages.filter((message) => selectedIds.has(message.id)).length;
        const rows = messages.map((message) => `<div class="review-message" data-id="${escapeHtml(message.id)}">
          <input class="review-message-check" type="checkbox" aria-label="Select ${escapeHtml(message.subject || "(no subject)")}" ${selectedIds.has(message.id) ? "checked" : ""}>
          <div class="review-message-copy">
            <strong>${escapeHtml(message.subject || "(no subject)")}</strong>
            <span>${escapeHtml(message.preview || "No preview available.")}</span>
          </div>
          <div class="review-actions">
            <button class="button button-outline keep-review" type="button">Keep</button>
            <button class="button button-outline delete-review" type="button">Delete</button>
          </div>
        </div>`).join("");
        return `<section class="review-group" data-sender="${escapeHtml(key)}">
          <header class="review-group-heading">
            <input class="review-sender-check" type="checkbox" aria-label="Select all visible messages from ${escapeHtml(sender)}" data-total="${messages.length}" data-selected="${selectedCount}" ${selectedCount === messages.length ? "checked" : ""}>
            <strong>${escapeHtml(sender)}</strong>
            <span>${messages.length} ${messages.length === 1 ? "message" : "messages"}</span>
            <button class="button button-outline keep-review-group-selected" type="button" aria-label="Keep selected messages from ${escapeHtml(sender)}" ${selectedCount ? "" : "disabled"}>Keep selected</button>
            <button class="button button-outline delete-review-group-selected" type="button" aria-label="Delete selected messages from ${escapeHtml(sender)}" ${selectedCount ? "" : "disabled"}>Delete selected</button>
          </header>
          ${rows}
        </section>`;
      }).join("");
    reviewList.innerHTML = html;
    reviewList.querySelectorAll(".review-sender-check").forEach((checkbox) => {
      const selectedCount = Number(checkbox.dataset.selected);
      const total = Number(checkbox.dataset.total);
      checkbox.indeterminate = selectedCount > 0 && selectedCount < total;
    });
    reviewList.classList.toggle("hidden", matching.length === 0);
    reviewEmpty.classList.toggle("hidden", matching.length !== 0);
    updateReviewSelectionLabel(matching);
    document.getElementById("review-empty-title").textContent = query ? "No review messages match." : "Your review folder is clear.";
    document.getElementById("review-empty-copy").textContent = query
      ? "Try another search, or clear the search box."
      : "Automatically sorted messages will appear here while Clearspace is running.";
    document.getElementById("refresh-button").hidden = true;
  };

  const visibleReviewMessages = () => {
    const query = activeSearchQuery().trim().toLowerCase();
    return reviewMessages.filter((message) => {
      const haystack = [message.sender, message.sender_email, message.subject, message.preview].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    });
  };

  const reviewSenderKey = (message) => message.sender_email || message.sender || "Unknown sender";

  const updateReviewSelectionLabel = (visible = visibleReviewMessages()) => {
    const selectedCount = visible.filter((message) => selectedIds.has(message.id)).length;
    document.getElementById("review-selected-count").textContent = `${selectedCount} selected`;
    const deleteButton = document.getElementById("delete-review-selected");
    deleteButton.disabled = selectedCount === 0;
    deleteButton.style.opacity = selectedCount ? "1" : ".55";
    document.getElementById("select-all-review").checked = visible.length > 0
      && visible.every((message) => selectedIds.has(message.id));
    reviewSelectionBar.classList.toggle("hidden", visible.length === 0);
  };

  const loadReviewMessages = async () => {
    const generation = ++reviewLoadGeneration;
    reviewMessages = [];
    reviewLoading = true;
    document.getElementById("review-progress").textContent = "Loading review messages…";
    document.getElementById("review-progress").classList.remove("error");
    renderReview();
    let cursor = null;
    try {
      do {
        const url = cursor ? `/api/review?cursor=${encodeURIComponent(cursor)}` : "/api/review";
        const data = await api(url);
        if (generation !== reviewLoadGeneration) return;
        reviewMessages.push(...(data.messages || []));
        cursor = data.next_cursor;
        renderReview();
      } while (cursor && generation === reviewLoadGeneration);
      if (generation === reviewLoadGeneration) {
        reviewLoading = false;
        renderReview();
      }
    } catch (error) {
      if (generation !== reviewLoadGeneration) return;
      reviewLoading = false;
      document.getElementById("review-progress").textContent = error.message;
      document.getElementById("review-progress").classList.add("error");
      showToast(`Could not load Clearspace Review. ${error.message}`, true);
    }
  };

  const updateSelectionLabel = () => {
    const count = selectedIds.size;
    document.getElementById("selected-count").textContent = `${count} selected`;
    const button = document.getElementById("delete-selected");
    button.disabled = count === 0;
    button.style.opacity = count ? "1" : ".55";
  };

  const updateAutoSortControl = () => {
    autoSortControl.classList.toggle("hidden", accountCard.classList.contains("hidden"));
    autoSortToggle.textContent = autoSortEnabled ? "Pause auto-sort" : "Enable auto-sort";
    autoSortStatus.textContent = autoSortBusy
      ? "Auto-sort is scanning"
      : autoSortEnabled ? "Auto-sort is on" : "Auto-sort is off";
  };

  const startAutoSortPolling = () => {
    clearInterval(autoSortTimer);
    autoSortTimer = setInterval(() => {
      if (autoSortEnabled) runAutoSortBatch();
    }, 60000);
  };

  const runAutoSortBatch = async () => {
    if (!autoSortEnabled || autoSortBusy) return;
    autoSortBusy = true;
    updateAutoSortControl();
    let cursor = null;
    let movedCount = 0;
    const movedIds = [];
    try {
      await messageScanPromise;
      if (!autoSortEnabled) return;
      do {
        const data = await api("/api/auto-sort/process", {
          method: "POST",
          body: JSON.stringify(cursor ? { cursor } : {}),
        });
        movedCount += data.moved || 0;
        movedIds.push(...(data.moved_ids || []));
        cursor = data.next_cursor;
      } while (cursor && autoSortEnabled);
      if (movedIds.length) {
        const moved = new Set(movedIds);
        allMessages = allMessages.filter((message) => !moved.has(message.id));
        movedIds.forEach((id) => selectedIds.delete(id));
        if (currentView !== "review") renderMessages();
        else await loadReviewMessages();
      }
      if (movedCount) {
        showToast(`${movedCount} ${movedCount === 1 ? "message" : "messages"} moved to Clearspace Review.`);
      }
    } catch (error) {
      if (!error.message.includes("already running")) showToast(`Automatic sorting paused after an error. ${error.message}`, true);
    } finally {
      autoSortBusy = false;
      updateAutoSortControl();
    }
  };

  const loadRemainingMessages = async (cursor, generation) => {
    while (cursor && generation === messageLoadGeneration) {
      try {
        const data = await api(`/api/messages?cursor=${encodeURIComponent(cursor)}`);
        if (generation !== messageLoadGeneration) return;
        const batch = data.messages || [];
        allMessages.push(...batch);
        cursor = data.next_cursor;
        messageScanInProgress = Boolean(cursor);
        if (currentView !== "review") renderMessages(batch);
      } catch (error) {
        if (generation !== messageLoadGeneration) return;
        messageScanInProgress = false;
        messageScanError = true;
        if (currentView !== "review") renderMessages();
        showToast(`Could not load the next inbox batch. ${error.message}`, true);
        return;
      }
    }
  };

  const loadMessages = async () => {
    const generation = ++messageLoadGeneration;
    messageScanInProgress = true;
    messageScanError = false;
    setViewVisible(dashboard, false);
    setViewVisible(loading, true);
    try {
      const data = await api("/api/messages");
      if (generation !== messageLoadGeneration) return;
      allMessages = data.messages || [];
      selectedIds.clear();
      messageScanInProgress = Boolean(data.next_cursor);
      renderMessages();
      messageScanPromise = data.next_cursor
        ? loadRemainingMessages(data.next_cursor, generation)
        : Promise.resolve();
    } catch (error) {
      if (generation !== messageLoadGeneration) return;
      messageScanInProgress = false;
      messageScanError = true;
      if (allMessages.length) {
        renderMessages();
        showToast(error.message, true);
      } else {
        setViewVisible(loading, false);
        setViewVisible(dashboard, false);
        setupError.textContent = `${error.message} Refresh this page to try again.`;
        setupError.classList.remove("hidden");
      }
    }
  };

  const applySenderFeedback = (senderEmail, action, messageId) => {
    allMessages.forEach((message) => {
      if (senderEmail ? message.sender_email !== senderEmail : message.id !== messageId) return;
      if (action === "keep") {
        message.reasons = [];
        message.suggested = false;
        message.learning_note = "Previously kept sender";
        keptIds.add(message.id);
      } else {
        keptIds.delete(message.id);
        message.reasons = (message.reasons || []).filter((reason) => reason !== "Previously deleted sender");
        message.reasons.push("Previously deleted sender");
        message.suggested = true;
        message.learning_note = "";
      }
    });
  };

  const deleteMessages = async (ids, actionButton = null) => {
    if (!ids.length || messageActionInProgress) return;
    const uniqueIds = [...new Set(ids)];
    const isReviewView = currentView === "review";
    const sourceMessages = isReviewView ? reviewMessages : allMessages;
    const button = actionButton || document.getElementById(isReviewView ? "delete-review-selected" : "delete-selected");
    const controls = isReviewView
      ? [...new Set([
        button,
        document.getElementById("delete-review-selected"),
        ...reviewList.querySelectorAll(".delete-review-group-selected, .keep-review-group-selected, .delete-review, .keep-review"),
      ])]
      : [button];
    const originalControls = new Map(controls.map((control) => [control, {
      disabled: control.disabled,
      content: control.innerHTML,
    }]));
    controls.forEach((control) => { control.disabled = true; });
    messageActionInProgress = true;
    try {
      const failed = [];
      const learningWarnings = [];
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const message = sourceMessages.find((item) => item.id === id);
        button.textContent = `Deleting ${index + 1} of ${uniqueIds.length}…`;
        try {
          const result = await api("/api/delete", {
            method: "POST",
            body: JSON.stringify({ id, sender_email: message?.sender_email || "" }),
          });
          if (message) applySenderFeedback(message.sender_email, "delete", message.id);
          if (isReviewView) reviewMessages = reviewMessages.filter((item) => item.id !== id);
          else allMessages = allMessages.filter((item) => item.id !== id);
          selectedIds.delete(id);
          if (!result.learning_saved) {
            learningWarnings.push(`${message?.subject || "An email"}: ${result.warning}`);
          }
        } catch (error) {
          failed.push(error.message);
        }
      }
      if (isReviewView) renderReview();
      else renderMessages();
      if (failed.length || learningWarnings.length) showToast(failed[0] || learningWarnings[0], true);
      else showToast(`${uniqueIds.length} ${uniqueIds.length === 1 ? "email" : "emails"} moved to Trash/Deleted Items.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      controls.forEach((control) => {
        if (!control.isConnected) return;
        control.innerHTML = originalControls.get(control).content;
        control.disabled = originalControls.get(control).disabled;
      });
      messageActionInProgress = false;
      if (isReviewView) updateReviewSelectionLabel();
      else updateSelectionLabel();
    }
  };

  const keepReviewMessages = async (ids, actionButton) => {
    if (!ids.length || messageActionInProgress) return;
    const uniqueIds = [...new Set(ids)];
    const controls = [...new Set([
      actionButton,
      document.getElementById("delete-review-selected"),
      ...reviewList.querySelectorAll(".delete-review-group-selected, .keep-review-group-selected, .delete-review, .keep-review"),
    ])];
    const originalControls = new Map(controls.map((control) => [control, {
      disabled: control.disabled,
      content: control.innerHTML,
    }]));
    controls.forEach((control) => { control.disabled = true; });
    messageActionInProgress = true;
    try {
      const failed = [];
      const warnings = [];
      let restoredCount = 0;
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const message = reviewMessages.find((item) => item.id === id);
        if (actionButton) actionButton.textContent = `Keeping ${index + 1} of ${uniqueIds.length}…`;
        try {
          const result = await api("/api/review/keep", {
            method: "POST",
            body: JSON.stringify({ id, sender_email: message?.sender_email || "" }),
          });
          reviewMessages = reviewMessages.filter((item) => item.id !== id);
          selectedIds.delete(id);
          if (message) {
            applySenderFeedback(message.sender_email, "keep", message.id);
            allMessages.push({ ...message, suggested: false, reasons: [], learning_note: "Previously kept sender" });
          }
          restoredCount += 1;
          if (!result.learning_saved) warnings.push(result.warning);
        } catch (error) {
          failed.push(error.message);
        }
      }
      renderReview();
      if (failed.length) {
        const restoredLabel = restoredCount === 1 ? "message" : "messages";
        showToast(
          `${restoredCount} ${restoredLabel} returned to Inbox; ${failed.length} could not be kept. ${failed[0]}`,
          true,
        );
      } else if (warnings.length) {
        showToast(warnings[0], true);
      } else {
        showToast(`${restoredCount} ${restoredCount === 1 ? "message" : "messages"} returned to your inbox.`);
      }
    } catch (error) {
      showToast(error.message, true);
    } finally {
      controls.forEach((control) => {
        if (!control.isConnected) return;
        control.innerHTML = originalControls.get(control).content;
        control.disabled = originalControls.get(control).disabled;
      });
      messageActionInProgress = false;
      updateReviewSelectionLabel();
    }
  };

  document.querySelectorAll(".nav-link").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === button));
      currentView = button.dataset.view;
      updateSearchContext();
      selectedIds.clear();
      messageList.scrollTop = 0;
      if (currentView === "review") loadReviewMessages();
      else {
        reviewLoadGeneration += 1;
        reviewLoading = false;
        renderMessages();
      }
    });
  });
  globalSearch.addEventListener("input", () => {
    searchQueries[currentView] = globalSearch.value;
    selectedIds.clear();
    if (currentView === "review") {
      reviewList.scrollTop = 0;
      renderReview();
    } else {
      messageList.scrollTop = 0;
      renderMessages();
    }
  });
  themeModeSelect.addEventListener("change", () => {
    const mode = themeModeSelect.value;
    setThemeMode(mode);
    try {
      localStorage.setItem("clearspace-theme-mode", mode);
    } catch (error) {
      showToast(`Theme changed, but the preference could not be saved: ${error.message}`, true);
    }
  });
  document.getElementById("refresh-button").addEventListener("click", loadMessages);
  document.getElementById("review-refresh").addEventListener("click", loadReviewMessages);
  document.getElementById("select-all-review").addEventListener("change", (event) => {
    visibleReviewMessages().forEach((message) => (
      event.target.checked ? selectedIds.add(message.id) : selectedIds.delete(message.id)
    ));
    renderReview();
  });
  document.getElementById("delete-review-selected").addEventListener("click", () => {
    deleteMessages([...selectedIds].filter((id) => reviewMessages.some((message) => message.id === id)));
  });
  autoSortToggle.addEventListener("click", async () => {
    const nextEnabled = !autoSortEnabled;
    const confirmation = nextEnabled
      ? "Enable auto-sort? Clearspace will scan the current inbox, then move likely promotions and newsletters to the recoverable Clearspace Review folder. It analyzes message content locally; receipts, bills, appointments, and messages from senders you marked Keep are excluded where detected. Future inbox messages are checked while this app is open."
      : "Pause automatic sorting? Messages already in Clearspace Review will remain there.";
    if (!window.confirm(confirmation)) return;
    autoSortToggle.disabled = true;
    try {
      const result = await api("/api/auto-sort", {
        method: "POST",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      autoSortEnabled = result.enabled;
      updateAutoSortControl();
      if (autoSortEnabled) {
        startAutoSortPolling();
        runAutoSortBatch();
      } else {
        clearInterval(autoSortTimer);
        showToast("Automatic sorting paused. Messages already moved remain in Clearspace Review.");
      }
    } catch (error) {
      showToast(error.message, true);
    } finally {
      autoSortToggle.disabled = false;
      updateAutoSortControl();
    }
  });
  reviewList.addEventListener("click", (event) => {
    const groupKeepButton = event.target.closest(".keep-review-group-selected");
    if (groupKeepButton) {
      const group = groupKeepButton.closest(".review-group");
      const sender = group.dataset.sender;
      const ids = visibleReviewMessages()
        .filter((message) => reviewSenderKey(message) === sender && selectedIds.has(message.id))
        .map((message) => message.id);
      keepReviewMessages(ids, groupKeepButton);
      return;
    }
    const groupDeleteButton = event.target.closest(".delete-review-group-selected");
    if (groupDeleteButton) {
      const group = groupDeleteButton.closest(".review-group");
      const sender = group.dataset.sender;
      const ids = visibleReviewMessages()
        .filter((message) => reviewSenderKey(message) === sender && selectedIds.has(message.id))
        .map((message) => message.id);
      deleteMessages(ids, groupDeleteButton);
      return;
    }
    const row = event.target.closest(".review-message");
    if (!row) return;
    if (event.target.closest(".delete-review")) {
      deleteMessages([row.dataset.id]);
      return;
    }
    const keepButton = event.target.closest(".keep-review");
    if (!keepButton) return;
    const message = reviewMessages.find((item) => item.id === row.dataset.id);
    if (!message) return;
    keepReviewMessages([message.id], keepButton);
  });
  reviewList.addEventListener("change", (event) => {
    if (event.target.classList.contains("review-sender-check")) {
      const group = event.target.closest(".review-group");
      const sender = group.dataset.sender;
      visibleReviewMessages()
        .filter((message) => reviewSenderKey(message) === sender)
        .forEach((message) => (
          event.target.checked ? selectedIds.add(message.id) : selectedIds.delete(message.id)
        ));
      renderReview();
      return;
    }
    if (!event.target.classList.contains("review-message-check")) return;
    const row = event.target.closest(".review-message");
    if (event.target.checked) selectedIds.add(row.dataset.id);
    else selectedIds.delete(row.dataset.id);
    renderReview();
  });
  document.getElementById("empty-switch").addEventListener("click", () => {
    currentView = "all";
    document.querySelector('[data-view="all"]').click();
  });
  document.getElementById("select-all").addEventListener("change", (event) => {
    visibleMessages().forEach((message) => event.target.checked ? selectedIds.add(message.id) : selectedIds.delete(message.id));
    renderMessages();
  });
  messageList.addEventListener("change", (event) => {
    if (!event.target.classList.contains("message-check")) return;
    const row = event.target.closest(".message-row");
    if (event.target.checked) selectedIds.add(row.dataset.id);
    else selectedIds.delete(row.dataset.id);
    updateSelectionLabel();
    document.getElementById("select-all").checked = visibleMessages().length > 0 && visibleMessages().every((message) => selectedIds.has(message.id));
  });
  messageList.addEventListener("click", async (event) => {
    const keepButton = event.target.closest(".keep-one");
    if (keepButton) {
      const id = keepButton.closest(".message-row").dataset.id;
      const message = allMessages.find((item) => item.id === id);
      keepButton.disabled = true;
      let feedbackError = "";
      try {
        await api("/api/feedback", {
          method: "POST",
          body: JSON.stringify({ action: "keep", sender_email: message?.sender_email || "" }),
        });
      } catch (error) {
        feedbackError = error.message;
      }
      applySenderFeedback(message?.sender_email, "keep", id);
      selectedIds.delete(id);
      renderMessages();
      showToast(feedbackError
        ? `Kept for this session, but learning feedback was not saved: ${feedbackError}`
        : "Kept. Future suggestions from this sender will be suppressed.");
      return;
    }
    const button = event.target.closest(".delete-one");
    if (button) deleteMessages([button.closest(".message-row").dataset.id]);
  });
  document.getElementById("delete-selected").addEventListener("click", () => deleteMessages([...selectedIds]));
  document.getElementById("disconnect-button").addEventListener("click", async () => {
    if (!window.confirm("Disconnect this email account from Clearspace?")) return;
    try {
      await api("/api/disconnect", { method: "POST" });
      location.reload();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.getElementById("clear-learning-button").addEventListener("click", async (event) => {
    if (!window.confirm("Clear learned sender patterns for this account? This will not change any email.")) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/api/feedback/reset", { method: "POST" });
      keptIds.clear();
      selectedIds.clear();
      await loadMessages();
      showToast("Learned patterns cleared. Your email messages were not changed.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  loadAccount();
})();
