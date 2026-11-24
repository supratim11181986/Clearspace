(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const welcome = document.getElementById("welcome-view");
  const dashboard = document.getElementById("dashboard-view");
  const loading = document.getElementById("loading-view");
  const setupError = document.getElementById("setup-error");
  const messageList = document.getElementById("message-list");
  const emptyState = document.getElementById("empty-state");
  const selectionBar = document.getElementById("selection-bar");
  const accountCard = document.getElementById("account-card");
  const toast = document.getElementById("toast");
  let allMessages = [];
  let currentView = "suggested";
  let keptIds = new Set();
  let selectedIds = new Set();
  let messageLoadGeneration = 0;
  let messageScanInProgress = false;
  let messageScanError = false;
  let toastTimer;

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
        setViewVisible(welcome, true);
        setViewVisible(dashboard, false);
        setViewVisible(loading, false);
        return;
      }
      document.getElementById("account-email").textContent = account.email;
      document.getElementById("account-provider").textContent = account.provider_name;
      document.getElementById("account-avatar").textContent = (account.email || "C").trim().charAt(0).toUpperCase();
      accountCard.classList.remove("hidden");
      document.getElementById("clear-learning-button").classList.remove("hidden");
      setViewVisible(welcome, false);
      setViewVisible(loading, true);
      await loadMessages();
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
    const query = document.getElementById("search-input").value.trim().toLowerCase();
    return allMessages.filter((message) => {
      if (currentView === "suggested" && (!message.suggested || keptIds.has(message.id))) return false;
      const haystack = [message.sender, message.subject, message.preview, ...(message.reasons || [])].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    });
  };

  const renderMessages = (addedMessages = null) => {
    const messages = visibleMessages();
    document.getElementById("suggestion-count").textContent = allMessages.filter((message) => message.suggested && !keptIds.has(message.id)).length;
    document.getElementById("inbox-count").textContent = allMessages.length;
    document.getElementById("nav-count").textContent = allMessages.filter((message) => message.suggested && !keptIds.has(message.id)).length;
    document.getElementById("breadcrumb-current").textContent = currentView === "suggested" ? "Suggested" : "All inbox";
    document.getElementById("list-title").textContent = currentView === "suggested" ? "Worth a second look" : "Your recent inbox";
    document.getElementById("list-description").textContent = currentView === "suggested"
      ? "Keep a sender to reduce future suggestions, or delete to flag that sender."
      : "Browse inbox messages. Delete moves mail to Trash/Deleted Items after confirmation.";
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
    const isFilteredEmpty = messages.length === 0 && Boolean(document.getElementById("search-input").value.trim());
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

  const updateSelectionLabel = () => {
    const count = selectedIds.size;
    document.getElementById("selected-count").textContent = `${count} selected`;
    const button = document.getElementById("delete-selected");
    button.disabled = count === 0;
    button.style.opacity = count ? "1" : ".55";
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
        renderMessages(batch);
      } catch (error) {
        if (generation !== messageLoadGeneration) return;
        messageScanInProgress = false;
        messageScanError = true;
        renderMessages();
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
      if (data.next_cursor) loadRemainingMessages(data.next_cursor, generation);
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

  const deleteMessages = async (ids) => {
    if (!ids.length) return;
    const uniqueIds = [...new Set(ids)];
    const label = uniqueIds.length === 1 ? "this email" : `${uniqueIds.length} emails`;
    if (!window.confirm(`Move ${label} to Trash/Deleted Items? This is recoverable there. Clearspace will not permanently delete mail.`)) return;
    const button = document.getElementById("delete-selected");
    const originalButtonContent = button.innerHTML;
    button.disabled = true;
    try {
      const failed = [];
      const learningWarnings = [];
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const message = allMessages.find((item) => item.id === id);
        button.textContent = `Deleting ${index + 1} of ${uniqueIds.length}…`;
        try {
          const result = await api("/api/delete", {
            method: "POST",
            body: JSON.stringify({ id, sender_email: message?.sender_email || "" }),
          });
          if (message) applySenderFeedback(message.sender_email, "delete", message.id);
          allMessages = allMessages.filter((item) => item.id !== id);
          selectedIds.delete(id);
          if (!result.learning_saved) {
            learningWarnings.push(`${message?.subject || "An email"}: ${result.warning}`);
          }
        } catch (error) {
          failed.push(error.message);
        }
      }
      renderMessages();
      if (failed.length || learningWarnings.length) showToast(failed[0] || learningWarnings[0], true);
      else showToast(`${uniqueIds.length} ${uniqueIds.length === 1 ? "email" : "emails"} moved to Trash/Deleted Items.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.innerHTML = originalButtonContent;
      updateSelectionLabel();
    }
  };

  document.querySelectorAll(".nav-link").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === button));
      currentView = button.dataset.view;
      selectedIds.clear();
      renderMessages();
    });
  });
  document.getElementById("search-input").addEventListener("input", () => {
    selectedIds.clear();
    renderMessages();
  });
  document.getElementById("refresh-button").addEventListener("click", loadMessages);
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
