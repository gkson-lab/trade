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
