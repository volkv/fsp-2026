// Statistics for the generators of the Data Science / ML families: the standard normal distribution, binomial
// coefficients and sample moments. The gates' Python references use the standard library (`statistics.NormalDist`,
// `math.comb`) instead, so a mistake here is caught there.

/** The standard normal density. */
function normalPdf(x: number): number {
	return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Φ(x), the standard normal distribution function: Marsaglia's series 0.5 + φ(x)·(x + x³/3 + x⁵/(3·5) + …), whose
 * terms are all of one sign — accurate to double precision for |x| ≤ 8; beyond it Φ is 0 or 1 within 1e-15.
 */
export function normalCdf(x: number): number {
	if (x <= -8) return 0;
	if (x >= 8) return 1;
	let term = x;
	let sum = x;
	for (let k = 1; k < 1000; k += 1) {
		term *= (x * x) / (2 * k + 1);
		const next = sum + term;
		if (next === sum) break;
		sum = next;
	}
	return 0.5 + normalPdf(x) * sum;
}

/** The quantile z with Φ(z) = p, 0 < p < 1, by bisection to double precision. */
export function normalQuantile(p: number): number {
	if (!(p > 0 && p < 1)) throw new Error(`normalQuantile(${p}): p must be in (0, 1)`);
	let lo = -8;
	let hi = 8;
	for (let i = 0; i < 200; i += 1) {
		const mid = (lo + hi) / 2;
		if (normalCdf(mid) < p) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** The binomial coefficient C(n, k) as a float (exact for the small n of the items). */
export function comb(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	let result = 1;
	for (let i = 1; i <= Math.min(k, n - k); i += 1) result = (result * (n - i + 1)) / i;
	return Math.round(result);
}

export function mean(xs: readonly number[]): number {
	if (xs.length === 0) throw new Error('mean of an empty sample');
	return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Variance with the divisor n − ddof: 1 — the sample variance, 0 — the population variance. */
export function variance(xs: readonly number[], ddof: 0 | 1): number {
	const m = mean(xs);
	return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - ddof);
}

/** Covariance of paired samples with the divisor n − ddof. */
export function covariance(xs: readonly number[], ys: readonly number[], ddof: 0 | 1): number {
	if (xs.length !== ys.length) throw new Error('covariance of samples of different sizes');
	const mx = mean(xs);
	const my = mean(ys);
	return xs.reduce((s, x, i) => s + (x - mx) * ((ys[i] ?? 0) - my), 0) / (xs.length - ddof);
}
