const HISTORY_PROPERTY = "DELIVERY_HISTORY";
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 200;

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function doGet() {
  return jsonResponse({ ok: true, service: "Amazon job watcher email bridge" });
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(5000)) {
      return jsonResponse({ ok: false, error: "Mail bridge is busy; retry shortly" });
    }

    const properties = PropertiesService.getScriptProperties();
    const expectedSecret = properties.getProperty("WEBHOOK_SECRET") || "";
    const recipient = properties.getProperty("ALERT_RECIPIENT") || "";
    const payload = JSON.parse((event.postData && event.postData.contents) || "{}");

    if (expectedSecret.length < 32 || payload.secret !== expectedSecret) {
      return jsonResponse({ ok: false, error: "Unauthorized" });
    }
    if (!/^\S+@\S+\.\S+$/.test(recipient)) {
      return jsonResponse({ ok: false, error: "ALERT_RECIPIENT is not configured" });
    }

    const deliveryId = String(payload.deliveryId || "");
    const subject = String(payload.subject || "").trim();
    const text = String(payload.text || "").trim();
    const html = String(payload.html || "").trim();
    if (!deliveryId || deliveryId.length > 500 || !subject || !text) {
      return jsonResponse({ ok: false, error: "Invalid message payload" });
    }
    if (subject.length > 200 || text.length > 50000 || html.length > 100000) {
      return jsonResponse({ ok: false, error: "Message payload is too large" });
    }

    const now = Date.now();
    let history = {};
    try {
      history = JSON.parse(properties.getProperty(HISTORY_PROPERTY) || "{}");
    } catch (_error) {
      history = {};
    }
    if (history[deliveryId]) {
      return jsonResponse({ ok: true, duplicate: true });
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      return jsonResponse({ ok: false, error: "Daily email quota is exhausted" });
    }

    MailApp.sendEmail({
      to: recipient,
      subject: subject,
      body: text,
      htmlBody: html || undefined,
      name: "Jason's Amazon Job Watcher",
    });

    history[deliveryId] = now;
    const retained = Object.entries(history)
      .filter(function (entry) {
        return Number(entry[1]) >= now - HISTORY_RETENTION_MS;
      })
      .sort(function (left, right) {
        return Number(right[1]) - Number(left[1]);
      })
      .slice(0, MAX_HISTORY_ENTRIES);
    properties.setProperty(HISTORY_PROPERTY, JSON.stringify(Object.fromEntries(retained)));
    return jsonResponse({ ok: true, duplicate: false });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse({ ok: false, error: String(error).slice(0, 500) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}
