/**
 * Camera scanner wrapper.
 * Tries the native BarcodeDetector API first (fast, no library weight).
 * Falls back to the html5-qrcode library (loaded from CDN) for browsers
 * that don't support BarcodeDetector, e.g. Safari/iOS.
 */
(function (global) {
  "use strict";

  function CameraScanner(videoEl, onDetect, onError) {
    this.videoEl = videoEl;
    this.onDetect = onDetect;
    this.onError = onError || function () {};
    this.stream = null;
    this.detector = null;
    this.rafId = null;
    this.running = false;
    this.lastValue = null;
    this.lastAt = 0;
    this.mode = null; // "native" | "fallback"
    this.html5Qr = null;
  }

  CameraScanner.isSupported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  CameraScanner.prototype._emit = function (value) {
    var now = Date.now();
    // Debounce repeated reads of the same code while it sits in frame.
    if (value === this.lastValue && now - this.lastAt < 1800) return;
    this.lastValue = value;
    this.lastAt = now;
    this.onDetect(value);
  };

  CameraScanner.prototype.start = async function () {
    if (this.running) return;
    if (!CameraScanner.isSupported()) {
      this.onError("no-camera-api");
      return;
    }

    if ("BarcodeDetector" in window) {
      try {
        this.detector = new window.BarcodeDetector();
        await this._startNative();
        return;
      } catch (e) {
        // fall through to library fallback
      }
    }
    await this._startFallback();
  };

  CameraScanner.prototype._startNative = async function () {
    var self = this;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
    } catch (e) {
      this.onError("camera-denied");
      return;
    }
    this.videoEl.srcObject = this.stream;
    await this.videoEl.play();
    this.mode = "native";
    this.running = true;

    async function tick() {
      if (!self.running) return;
      try {
        var codes = await self.detector.detect(self.videoEl);
        if (codes && codes.length) {
          self._emit(codes[0].rawValue);
        }
      } catch (e) {
        /* transient decode errors are normal, keep looping */
      }
      self.rafId = requestAnimationFrame(tick);
    }
    tick();
  };

  CameraScanner.prototype._startFallback = async function () {
    var self = this;
    if (typeof Html5Qrcode === "undefined") {
      this.onError("fallback-load-failed");
      return;
    }
    var containerId = this.videoEl.dataset.fallbackContainer;
    this.html5Qr = new Html5Qrcode(containerId, { verbose: false });
    this.mode = "fallback";
    try {
      await this.html5Qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        function (decodedText) {
          self._emit(decodedText);
        },
        function () {} /* per-frame scan failures are normal, ignore */
      );
      this.running = true;
    } catch (e) {
      this.onError("camera-denied");
    }
  };

  CameraScanner.prototype.stop = function () {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) {
        t.stop();
      });
      this.stream = null;
    }
    if (this.html5Qr) {
      try {
        this.html5Qr.stop().catch(function () {});
      } catch (e) {}
    }
  };

  CameraScanner.prototype.setTorch = async function (on) {
    if (this.mode === "native" && this.stream) {
      var track = this.stream.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        try {
          await track.applyConstraints({ advanced: [{ torch: on }] });
          return true;
        } catch (e) {
          return false;
        }
      }
    }
    return false;
  };

  global.CameraScanner = CameraScanner;
})(window);
