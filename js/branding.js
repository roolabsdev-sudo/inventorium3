/**
 * Branding: venue name, subtitle and logo. Defaults are neutral placeholders;
 * admins change them in Settings -> Branding. The last-known value is cached in
 * localStorage so pages paint with the right name immediately.
 *
 * Markup hooks: [data-brand-name], [data-brand-sub], img[data-brand-logo], and
 * <title data-page="Inventory"> (becomes "Inventory — <name> <subtitle>").
 */
(function (global) {
  "use strict";
  var FN = "/.netlify/functions/branding";
  var KEY = "venue_branding_v1";
  var PLACEHOLDER = "img/logo-placeholder.png";
  var DEFAULTS = { appName: "Inventorium", appSubtitle: "", logo: null };

  function clean(d) {
    d = d || {};
    return {
      appName: String(d.appName || "").trim() || DEFAULTS.appName,
      appSubtitle: d.appSubtitle == null ? DEFAULTS.appSubtitle : String(d.appSubtitle).trim(),
      logo: typeof d.logo === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(d.logo) ? d.logo : null
    };
  }
  function readCache() { try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch (e) { return clean(DEFAULTS); } }
  function writeCache(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }

  var current = readCache();

  function apply() {
    var t = document.querySelector("title[data-page]");
    if (t) {
      var page = t.getAttribute("data-page");
      var base = [current.appName, current.appSubtitle].filter(Boolean).join(" ");
      document.title = page ? page + " — " + base : base;
    }
    [].forEach.call(document.querySelectorAll("[data-brand-name]"), function (el) { el.textContent = current.appName; });
    [].forEach.call(document.querySelectorAll("[data-brand-sub]"), function (el) { el.textContent = current.appSubtitle; });
    [].forEach.call(document.querySelectorAll("img[data-brand-logo]"), function (el) { el.src = current.logo || PLACEHOLDER; });
  }

  function set(d) { current = clean(d); writeCache(current); apply(); return current; }

  function parse(res) {
    return res.text().then(function (text) {
      var json = {};
      try { json = text ? JSON.parse(text) : {}; } catch (e) {}
      if (!res.ok) throw new Error(json.error || "Request failed (" + res.status + ")");
      return json;
    });
  }
  function authed(method, body) {
    var user = global.netlifyIdentity && global.netlifyIdentity.currentUser();
    if (!user) return Promise.reject(new Error("Not logged in."));
    return user.jwt().then(function (token) {
      return fetch(FN, {
        method: method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
    }).then(parse).then(set);
  }

  global.Branding = {
    DEFAULTS: DEFAULTS,
    get: function () { return current; },
    logoSrc: function (d) { return (d || current).logo || PLACEHOLDER; },
    apply: apply,
    save: function (d) { return authed("POST", d); },
    reset: function () { return authed("DELETE"); }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
  apply();
  fetch(FN, { cache: "no-store" }).then(parse).then(set).catch(function () {});
})(window);
