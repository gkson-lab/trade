/* Seeded random numbers. Every run is reproducible from its seed. */
(function (T) {
  "use strict";

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function RNG(seed) {
    this.s = (seed >>> 0) || 1;
    this._spare = null;
  }
  // mulberry32
  RNG.prototype.next = function () {
    var t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (a, b) { return a + Math.floor(this.next() * (b - a + 1)); };
  RNG.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length)]; };
  RNG.prototype.chance = function (p) { return this.next() < p; };
  RNG.prototype.normal = function () {
    if (this._spare !== null) { var v = this._spare; this._spare = null; return v; }
    var u, w, x;
    do {
      u = this.next() * 2 - 1;
      w = this.next() * 2 - 1;
      x = u * u + w * w;
    } while (x >= 1 || x === 0);
    var m = Math.sqrt(-2 * Math.log(x) / x);
    this._spare = w * m;
    return u * m;
  };
  /* A cheaper normal from one uniform draw and a precomputed inverse-CDF table (tails reach about 4.4 sigma).
   * Used for the cosmetic parts of every bar (wicks, volume, open noise) where the exact far tail doesn't matter. */
  var FN = 16384, FNT = (function () {
    function inv(p) {   // Acklam's inverse normal CDF
      var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
        b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
        c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
        d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q, r;
      if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
      if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
      q = p - 0.5; r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    var t = new Float64Array(FN + 1);
    for (var k = 0; k <= FN; k++) t[k] = inv((k + 0.5) / (FN + 1));
    return t;
  })();
  RNG.prototype.fastNormal = function () {
    var x = this.next() * FN, k = x | 0;
    return FNT[k] + (FNT[k + 1] - FNT[k]) * (x - k);
  };
  // Student-t with nu degrees of freedom, rescaled to unit variance (fat tails).
  RNG.prototype.studentT = function (nu) {
    var z = this.normal(), chi = 0;
    for (var i = 0; i < nu; i++) { var g = this.normal(); chi += g * g; }
    return z / Math.sqrt(chi / nu) * Math.sqrt((nu - 2) / nu);
  };
  RNG.prototype.poisson = function (lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    var L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  };
  RNG.prototype.fork = function (label) {
    return new RNG((hashStr(String(label)) ^ Math.floor(this.next() * 4294967296)) >>> 0);
  };

  T.RNG = RNG;
  T.hashStr = hashStr;
})(typeof window !== "undefined" ? (window.T = window.T || {}) : (globalThis.T = globalThis.T || {}));
