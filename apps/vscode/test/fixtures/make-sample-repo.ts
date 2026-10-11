// Builds the sample repository the tests review: a small storefront ("Juniper Shop") with a
// short main history and a feature branch, feature/promo-codes, that reads like a real pull
// request. The tag `last-review` marks the commit the reviewer last looked at, so tests can
// check what changed since then.
//
// Authors, dates and contents are fixed, so the commit ids are the same on every machine.
//
// Usage (from apps/vscode):
//   node test/fixtures/make-sample-repo.ts                 # build test/fixtures/sample-repo/ if it's missing
//   node test/fixtures/make-sample-repo.ts --force         # rebuild it from scratch
//   node test/fixtures/make-sample-repo.ts <path> [--force]
//
// Tests call ensureSampleRepo(), which builds it on first use.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SAMPLE_REPO = resolve(dirname(fileURLToPath(import.meta.url)), "sample-repo");

const PEOPLE = {
  maya: ["Maya Chen", "maya@juniper.example"],
  leo: ["Leo Park", "leo@juniper.example"],
  priya: ["Priya Nair", "priya@juniper.example"],
  jordan: ["Jordan Lee", "jordan@juniper.example"],
} as const;

/** Strip the newline after the opening backtick so files start on line 1. */
const src = (text: string) => (text.startsWith("\n") ? text.slice(1) : text);

/** String.replace that fails loudly when the text to replace isn't there. */
function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`make-sample-repo: ${JSON.stringify(from.slice(0, 60))} not found`);
  return text.replace(from, () => to);
}

/* ---------- package.json and package-lock.json ---------- */

const DEV_DEPS = { eslint: "^9.11.1", typescript: "^5.6.2", vitest: "^2.1.1" };

function dependencies(zod: boolean): Record<string, string> {
  return zod ? { pg: "^8.13.0", react: "^18.3.1", zod: "^3.23.8" } : { pg: "^8.13.0", react: "^18.3.1" };
}

function packageJson(version: string, zod = false): string {
  const data = {
    name: "juniper-shop",
    version,
    private: true,
    type: "module",
    scripts: { build: "tsc -p .", test: "vitest run", lint: "eslint ." },
    dependencies: dependencies(zod),
    devDependencies: DEV_DEPS,
  };
  return JSON.stringify(data, null, 2) + "\n";
}

function npm(name: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = name.split("/").at(-1);
  const entry: Record<string, unknown> = { version, resolved: `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`, ...extra };
  if (!("license" in entry)) entry.license = "MIT";
  return entry;
}

function packageLock(version: string, zod = false, typescript = "5.6.2"): string {
  const packages: Record<string, unknown> = {
    "": { name: "juniper-shop", version, dependencies: dependencies(zod), devDependencies: DEV_DEPS },
    "node_modules/eslint": npm("eslint", "9.11.1", { dev: true, bin: { eslint: "bin/eslint.js" }, engines: { node: "^18.18.0 || ^20.9.0 || >=21.1.0" } }),
    "node_modules/js-tokens": npm("js-tokens", "4.0.0"),
    "node_modules/loose-envify": npm("loose-envify", "1.4.0", { dependencies: { "js-tokens": "^3.0.0 || ^4.0.0" }, bin: { "loose-envify": "cli.js" } }),
    "node_modules/pg": npm("pg", "8.13.0", {
      dependencies: { "pg-connection-string": "^2.7.0", "pg-pool": "^3.7.0", "pg-protocol": "^1.7.0", "pg-types": "^2.1.0", pgpass: "1.x" },
      engines: { node: ">= 8.0.0" },
    }),
    "node_modules/pg-connection-string": npm("pg-connection-string", "2.7.0"),
    "node_modules/pg-pool": npm("pg-pool", "3.7.0", { peerDependencies: { pg: ">=8.0" } }),
    "node_modules/pg-protocol": npm("pg-protocol", "1.7.0"),
    "node_modules/pg-types": npm("pg-types", "2.2.0", { engines: { node: ">=4" } }),
    "node_modules/pgpass": npm("pgpass", "1.0.5", { dependencies: { split2: "^4.1.0" } }),
    "node_modules/react": npm("react", "18.3.1", { dependencies: { "loose-envify": "^1.1.0" }, engines: { node: ">=0.10.0" } }),
    "node_modules/split2": npm("split2", "4.2.0", { license: "ISC", engines: { node: ">= 10.x" } }),
    "node_modules/typescript": npm("typescript", typescript, {
      dev: true,
      license: "Apache-2.0",
      bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" },
      engines: { node: ">=14.17" },
    }),
    "node_modules/vitest": npm("vitest", "2.1.1", { dev: true, bin: { vitest: "vitest.mjs" }, engines: { node: "^18.0.0 || >=20.0.0" } }),
  };
  if (zod) packages["node_modules/zod"] = npm("zod", "3.23.8", { funding: { url: "https://github.com/sponsors/colinhacks" } });
  const data = { name: "juniper-shop", version, lockfileVersion: 3, requires: true, packages };
  return JSON.stringify(data, null, 2) + "\n";
}

/* ---------- Files on main ---------- */

const README = src(`
# Juniper Shop

Storefront and checkout for Juniper, a small plant shop.

| Path | What lives there |
| --- | --- |
| \`src/\` | Cart, checkout, payments and database code |
| \`web/\` | React components for the storefront |

## Development

    npm install
    npm test

This repository is sample data for the Diffline review concept.
`);

const CHANGELOG_V0 = src(`
# Changelog

## Unreleased

- Saved carts sync across devices.
- Faster search suggestions.

## 1.7.0 (2026-08-18)

- Checkout with saved payment methods.
- Order confirmation emails.
`);

const CHANGELOG_V1 = src(`
# Changelog

## Unreleased

## 1.8.0 (2026-09-02)

- Saved carts sync across devices.
- Faster search suggestions.

## 1.7.0 (2026-08-18)

- Checkout with saved payment methods.
- Order confirmation emails.
`);

const CHANGELOG_V2 = src(`
# Changelog

## Unreleased

- Promo codes at checkout: percent and fixed-amount discounts.

## 1.8.0 (2026-09-02)

- Saved carts sync across devices.
- Faster search suggestions.

## 1.7.0 (2026-08-18)

- Checkout with saved payment methods.
- Order confirmation emails.
`);

const TSCONFIG = src(`
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "web"]
}
`);

const CI_YML = src(`
name: CI

on:
  pull_request:
  merge_group:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint

  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test

  e2e:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx playwright test --project=checkout

  migration-safety:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: ./scripts/check-migrations.sh
`);

const CHECK_MIGRATIONS = src(`
#!/usr/bin/env sh
# Fails when a migration rewrites a table or drops data.
set -eu

for file in $(git diff --name-only origin/main -- 'src/db/migrations/*.sql'); do
  if grep -Eiq 'DROP (TABLE|COLUMN)|ALTER COLUMN .* TYPE' "$file"; then
    echo "Unsafe migration: $file"
    exit 1
  fi
done

echo "Migrations look additive."
`);

const CODEOWNERS = src(`
# Default owners for everything in the repository
*                     @juniper/platform

/web/                 @leo-park @juniper/frontend
/src/payments/        @juniper/payments
/src/db/migrations/   @juniper/platform
`);

const CURRENCY = src(`
/**
 * Money is always stored as integer cents to avoid floating point drift.
 */
export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}

export function formatPrice(cents: Cents, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function sum(values: Cents[]): Cents {
  return values.reduce((total, value) => total + value, 0);
}
`);

const CART_V0 = src(`
import { Cents, sum } from "../utils/currency";

export interface CartItem {
  sku: string;
  name: string;
  unitPrice: Cents;
  quantity: number;
}

export interface Cart {
  id: string;
  customerId: string;
  items: CartItem[];
}

export interface CartTotals {
  subtotal: Cents;
  shipping: Cents;
  tax: Cents;
  total: Cents;
}

const FREE_SHIPPING_THRESHOLD: Cents = 5000;
const FLAT_SHIPPING: Cents = 599;
const TAX_RATE = 0.0825;

export function lineTotal(item: CartItem): Cents {
  return item.unitPrice * item.quantity;
}

export function calculateTotals(cart: Cart): CartTotals {
  const subtotal = sum(cart.items.map(lineTotal));
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
  const tax = Math.round(subtotal * TAX_RATE);

  return {
    subtotal,
    shipping,
    tax,
    total: subtotal + shipping + tax,
  };
}
`);

const CART_TEST = src(`
import { describe, expect, it } from "vitest";
import { calculateTotals } from "./cart";

const cart = (unitPrice: number, quantity = 1) => ({
  id: "cart_1",
  customerId: "cus_1",
  items: [{ sku: "FERN-01", name: "Boston fern", unitPrice, quantity }],
});

describe("calculateTotals", () => {
  it("charges flat shipping under the threshold", () => {
    expect(calculateTotals(cart(2000)).shipping).toBe(599);
  });

  it("ships free from $50", () => {
    expect(calculateTotals(cart(2500, 2)).shipping).toBe(0);
  });

  it("adds sales tax", () => {
    expect(calculateTotals(cart(1000)).tax).toBe(83);
  });
});
`);

const CHECKOUT_V0 = src(`
import { calculateTotals, Cart } from "../cart/cart";
import { db } from "../db";
import { chargeCustomer } from "../payments/charge";

export interface CheckoutRequest {
  cartId: string;
  paymentMethodId: string;
}

export async function checkout(req: CheckoutRequest) {
  const cart: Cart | undefined = await db.carts.find(req.cartId);
  if (!cart || cart.items.length === 0) {
    return { status: 400, body: { error: "empty_cart" } };
  }

  const totals = calculateTotals(cart);
  const charge = await chargeCustomer({
    customerId: cart.customerId,
    paymentMethodId: req.paymentMethodId,
    amount: totals.total,
    description: \`Juniper order \${cart.id}\`,
  });

  const order = await db.orders.create({
    cartId: cart.id,
    customerId: cart.customerId,
    chargeId: charge.id,
    ...totals,
  });

  return { status: 201, body: { orderId: order.id, total: totals.total } };
}
`);

const CHARGE_V0 = src(`
import { Cents } from "../utils/currency";
import { paymentProvider } from "./provider";

export interface ChargeRequest {
  customerId: string;
  paymentMethodId: string;
  amount: Cents;
  description: string;
}

export interface Charge {
  id: string;
  amount: Cents;
  status: "succeeded" | "requires_action" | "failed";
}

export async function chargeCustomer(req: ChargeRequest): Promise<Charge> {
  const intent = await paymentProvider.paymentIntents.create({
    customer: req.customerId,
    payment_method: req.paymentMethodId,
    amount: req.amount,
    currency: "usd",
    description: req.description,
    confirm: true,
  });

  return { id: intent.id, amount: intent.amount, status: intent.status };
}
`);

const PROVIDER = src(`
/**
 * Thin wrapper around the card processor's SDK. Tests swap in a fake.
 */
export interface PaymentIntent {
  id: string;
  amount: number;
  status: "succeeded" | "requires_action" | "failed";
}

export interface PaymentProvider {
  paymentIntents: {
    create(params: Record<string, unknown>): Promise<PaymentIntent>;
  };
}

export let paymentProvider: PaymentProvider = {
  paymentIntents: {
    async create() {
      throw new Error("Payment provider is not configured");
    },
  },
};

export function setPaymentProvider(provider: PaymentProvider) {
  paymentProvider = provider;
}
`);

const SQL_TS = src(`
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const toCamel = (key: string) => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
export const toSnake = (key: string) => key.replace(/[A-Z]/g, (letter) => \`_\${letter.toLowerCase()}\`);

/** Runs a query and returns rows with camelCase keys. */
export async function sql<Row>(text: string, values: unknown[] = []): Promise<Row[]> {
  const result = await pool.query(text, values);
  return result.rows.map(
    (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [toCamel(key), value])) as Row,
  );
}
`);

const REPOSITORY_TS = src(`
import { sql, toSnake } from "./sql";

/** One small repository per table, so call sites read like \`db.orders.create(...)\`. */
export interface Repository<Row> {
  find(key: string): Promise<Row | undefined>;
  create(values: Partial<Row>): Promise<Row & { id: string }>;
  increment(key: string, column: keyof Row & string): Promise<void>;
}

export function createRepository<Row>(table: string, keyColumn = "id"): Repository<Row> {
  return {
    async find(key) {
      const [row] = await sql<Row>(\`SELECT * FROM \${table} WHERE \${keyColumn} = $1\`, [key]);
      return row;
    },
    async create(values) {
      const columns = Object.keys(values).map(toSnake);
      const placeholders = columns.map((_, index) => \`$\${index + 1}\`).join(", ");
      const [row] = await sql<Row & { id: string }>(
        \`INSERT INTO \${table} (\${columns.join(", ")}) VALUES (\${placeholders}) RETURNING *\`,
        Object.values(values),
      );
      return row;
    },
    async increment(key, column) {
      const name = toSnake(column);
      await sql(\`UPDATE \${table} SET \${name} = \${name} + 1 WHERE \${keyColumn} = $1\`, [key]);
    },
  };
}
`);

const DB_INDEX_V0 = src(`
import type { Cart } from "../cart/cart";
import { createRepository } from "./repository";

export interface OrderRow {
  id: string;
  cartId: string;
  customerId: string;
  chargeId: string;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}

export const db = {
  carts: createRepository<Cart>("carts"),
  orders: createRepository<OrderRow>("orders"),
};
`);

const MIGRATION_0006 = src(`
-- Carts outlive sessions so customers can pick up on another device.
CREATE TABLE carts (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX carts_customer_id ON carts (customer_id);
`);

const SUMMARY_V0 = src(`
import type { CartTotals } from "../../src/cart/cart";
import { formatPrice } from "../../src/utils/currency";

interface Props {
  totals: CartTotals;
}

export function CheckoutSummary({ totals }: Props) {
  return (
    <dl className="summary">
      <div className="summary-row">
        <dt>Subtotal</dt>
        <dd>{formatPrice(totals.subtotal)}</dd>
      </div>
      <div className="summary-row">
        <dt>Shipping</dt>
        <dd>{totals.shipping === 0 ? "Free" : formatPrice(totals.shipping)}</dd>
      </div>
      <div className="summary-row">
        <dt>Tax</dt>
        <dd>{formatPrice(totals.tax)}</dd>
      </div>
      <div className="summary-row summary-total">
        <dt>Total</dt>
        <dd>{formatPrice(totals.total)}</dd>
      </div>
    </dl>
  );
}
`);

/* ---------- Files on feature/promo-codes ---------- */

const MONEY =
  CURRENCY +
  src(`

/** \`percent\` of an amount, rounded down so a discount never exceeds what was advertised. */
export function percentOf(cents: Cents, percent: number): Cents {
  return Math.floor((cents * percent) / 100);
}
`);

const PROMO_HEAD = src(`
import { Cents, percentOf } from "../lib/money";

export type PromoKind = "percent" | "fixed";

export interface PromoCode {
  code: string;
  kind: PromoKind;
  /** Percent off (1–100) or a fixed amount in cents. */
  value: number;
  minSubtotal?: Cents;
  startsAt: Date;
  expiresAt?: Date;
  maxRedemptions?: number;
  redemptions: number;
}

/** The part of a promo code that travels with the cart and the order. */
export interface AppliedPromo {
  code: string;
  kind: PromoKind;
  value: number;
}

export type PromoError =
  | "not_found"
  | "not_started"
  | "expired"
  | "below_minimum"
  | "fully_redeemed";

export type PromoResult =
  | { ok: true; promo: AppliedPromo }
  | { ok: false; error: PromoError };
`);

const PROMO_VALIDATE = src(`
export function validatePromo(
  promo: PromoCode | undefined,
  subtotal: Cents,
  now: Date = new Date(),
): PromoResult {
  if (!promo) return { ok: false, error: "not_found" };
  if (now < promo.startsAt) return { ok: false, error: "not_started" };
  if (promo.expiresAt && now >= promo.expiresAt) return { ok: false, error: "expired" };
  if (promo.minSubtotal && subtotal < promo.minSubtotal) {
    return { ok: false, error: "below_minimum" };
  }
  if (promo.maxRedemptions !== undefined && promo.redemptions >= promo.maxRedemptions) {
    return { ok: false, error: "fully_redeemed" };
  }

  return { ok: true, promo: { code: promo.code, kind: promo.kind, value: promo.value } };
}
`);

const PROMO_V1 =
  PROMO_HEAD +
  "\n" +
  PROMO_VALIDATE +
  src(`

export function discountFor(promo: AppliedPromo, subtotal: Cents): Cents {
  return promo.kind === "percent" ? percentOf(subtotal, promo.value) : promo.value;
}
`);

const PROMO_V2 =
  PROMO_HEAD +
  src(`

/** Customers type codes in every possible way, so compare them normalized. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

`) +
  PROMO_VALIDATE +
  src(`

/** Never discount more than the subtotal, so a total can't go negative. */
export function discountFor(promo: AppliedPromo, subtotal: Cents): Cents {
  const discount = promo.kind === "percent" ? percentOf(subtotal, promo.value) : promo.value;
  return Math.min(discount, subtotal);
}
`);

const MIGRATION_0007 = src(`
-- Promo codes customers can enter at checkout.
CREATE TABLE promo_codes (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value           INTEGER NOT NULL CHECK (value > 0),
  min_subtotal    INTEGER,
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  max_redemptions INTEGER,
  redemptions     INTEGER NOT NULL DEFAULT 0
);

-- Orders remember which code was used and how much it took off.
ALTER TABLE orders
  ADD COLUMN promo_code TEXT REFERENCES promo_codes (code),
  ADD COLUMN discount   INTEGER NOT NULL DEFAULT 0;
`);

const DB_INDEX_V1 = src(`
import type { Cart } from "../cart/cart";
import type { PromoCode } from "../promotions/promo";
import { createRepository } from "./repository";

export interface OrderRow {
  id: string;
  cartId: string;
  customerId: string;
  chargeId: string;
  promoCode: string | null;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
}

export const db = {
  carts: createRepository<Cart>("carts"),
  orders: createRepository<OrderRow>("orders"),
  promoCodes: createRepository<PromoCode>("promo_codes", "code"),
};
`);

const CART_V2 = src(`
import { Cents, sum } from "../lib/money";
import { AppliedPromo, discountFor } from "../promotions/promo";

export interface CartItem {
  sku: string;
  name: string;
  unitPrice: Cents;
  quantity: number;
}

export interface Cart {
  id: string;
  customerId: string;
  items: CartItem[];
}

export interface CartTotals {
  subtotal: Cents;
  discount: Cents;
  shipping: Cents;
  tax: Cents;
  total: Cents;
}

const FREE_SHIPPING_THRESHOLD: Cents = 5000;
const FLAT_SHIPPING: Cents = 599;
const TAX_RATE = 0.0825;

export function lineTotal(item: CartItem): Cents {
  return item.unitPrice * item.quantity;
}

export function calculateTotals(cart: Cart, promo?: AppliedPromo): CartTotals {
  const subtotal = sum(cart.items.map(lineTotal));
  const discount = promo ? discountFor(promo, subtotal) : 0;
  const discounted = subtotal - discount;

  // Shipping and tax are based on what the customer actually pays.
  const shipping = discounted >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
  const tax = Math.round(discounted * TAX_RATE);

  return {
    subtotal,
    discount,
    shipping,
    tax,
    total: discounted + shipping + tax,
  };
}
`);

const PROMO_TEST_V1 = src(`
import { describe, expect, it } from "vitest";
import { discountFor, PromoCode, validatePromo } from "./promo";

const fall15: PromoCode = {
  code: "FALL15",
  kind: "percent",
  value: 15,
  startsAt: new Date("2026-09-01T00:00:00Z"),
  expiresAt: new Date("2026-11-01T00:00:00Z"),
  redemptions: 0,
};

const october = new Date("2026-10-10T12:00:00Z");

describe("validatePromo", () => {
  it("accepts an active code", () => {
    expect(validatePromo(fall15, 4000, october)).toEqual({
      ok: true,
      promo: { code: "FALL15", kind: "percent", value: 15 },
    });
  });

  it("rejects unknown codes", () => {
    expect(validatePromo(undefined, 4000, october)).toEqual({ ok: false, error: "not_found" });
  });

  it("rejects expired codes", () => {
    const november = new Date("2026-11-02T00:00:00Z");
    expect(validatePromo(fall15, 4000, november)).toEqual({ ok: false, error: "expired" });
  });

  it("enforces the minimum subtotal", () => {
    const promo = { ...fall15, minSubtotal: 5000 };
    expect(validatePromo(promo, 4999, october)).toEqual({ ok: false, error: "below_minimum" });
  });

  it("stops at the redemption limit", () => {
    const promo = { ...fall15, maxRedemptions: 100, redemptions: 100 };
    expect(validatePromo(promo, 4000, october)).toEqual({ ok: false, error: "fully_redeemed" });
  });
});

describe("discountFor", () => {
  it("takes a percentage off, rounding down", () => {
    expect(discountFor({ code: "FALL15", kind: "percent", value: 15 }, 1999)).toBe(299);
  });

  it("takes a fixed amount off", () => {
    expect(discountFor({ code: "TENOFF", kind: "fixed", value: 1000 }, 4000)).toBe(1000);
  });
});
`);

const PROMO_TEST_V2 = swap(
  swap(
    PROMO_TEST_V1,
    'import { discountFor, PromoCode, validatePromo } from "./promo";',
    'import { discountFor, normalizeCode, PromoCode, validatePromo } from "./promo";',
  ),
  src(`
    expect(discountFor({ code: "TENOFF", kind: "fixed", value: 1000 }, 4000)).toBe(1000);
  });
});
`),
  src(`
    expect(discountFor({ code: "TENOFF", kind: "fixed", value: 1000 }, 4000)).toBe(1000);
  });

  it("never takes off more than the subtotal", () => {
    expect(discountFor({ code: "TENOFF", kind: "fixed", value: 1000 }, 600)).toBe(600);
  });
});

describe("normalizeCode", () => {
  it("ignores case and surrounding spaces", () => {
    expect(normalizeCode("  fall15 ")).toBe("FALL15");
  });
});
`),
);

const CHECKOUT_V1 = src(`
import { z } from "zod";
import { calculateTotals, Cart } from "../cart/cart";
import { db } from "../db";
import { chargeCustomer } from "../payments/charge";
import { AppliedPromo, validatePromo } from "../promotions/promo";

const CheckoutRequest = z.object({
  cartId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  promoCode: z.string().max(32).optional(),
});

export async function checkout(input: unknown) {
  const parsed = CheckoutRequest.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const req = parsed.data;

  const cart: Cart | undefined = await db.carts.find(req.cartId);
  if (!cart || cart.items.length === 0) {
    return { status: 400, body: { error: "empty_cart" } };
  }

  let promo: AppliedPromo | undefined;
  if (req.promoCode) {
    const { subtotal } = calculateTotals(cart);
    const result = validatePromo(await db.promoCodes.find(req.promoCode), subtotal);
    if (!result.ok) {
      return { status: 400, body: { error: "invalid_promo", reason: result.error } };
    }
    promo = result.promo;
  }

  const totals = calculateTotals(cart, promo);
  const charge = await chargeCustomer({
    customerId: cart.customerId,
    paymentMethodId: req.paymentMethodId,
    amount: totals.total,
    description: \`Juniper order \${cart.id}\`,
    promoCode: promo?.code,
  });

  const order = await db.orders.create({
    cartId: cart.id,
    customerId: cart.customerId,
    chargeId: charge.id,
    promoCode: promo?.code ?? null,
    ...totals,
  });

  if (promo) {
    await db.promoCodes.increment(promo.code, "redemptions");
  }

  return { status: 201, body: { orderId: order.id, total: totals.total } };
}
`);

const CHECKOUT_V2 = swap(
  swap(
    CHECKOUT_V1,
    'import { AppliedPromo, validatePromo } from "../promotions/promo";',
    'import { AppliedPromo, normalizeCode, validatePromo } from "../promotions/promo";',
  ),
  "    const result = validatePromo(await db.promoCodes.find(req.promoCode), subtotal);\n",
  "    const code = normalizeCode(req.promoCode);\n" + "    const result = validatePromo(await db.promoCodes.find(code), subtotal);\n",
);

const CHARGE_V1 = swap(CHARGE_V0, '"../utils/currency"', '"../lib/money"');

const CHARGE_V2 = swap(
  swap(CHARGE_V1, "  description: string;\n}", "  description: string;\n  promoCode?: string;\n}"),
  "    description: req.description,\n    confirm: true,",
  "    description: req.description,\n" + "    metadata: req.promoCode ? { promo_code: req.promoCode } : undefined,\n" + "    confirm: true,",
);

const CHARGE_V3 = swap(
  CHARGE_V2,
  "export async function chargeCustomer(req: ChargeRequest): Promise<Charge> {\n",
  src(`
/** Last line of defense: never send a zero, negative or fractional amount. */
function assertChargeable(amount: Cents): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(\`Refusing to charge \${amount} cents\`);
  }
}

export async function chargeCustomer(req: ChargeRequest): Promise<Charge> {
  assertChargeable(req.amount);

`),
);

const SUMMARY_V1 = swap(SUMMARY_V0, '"../../src/utils/currency"', '"../../src/lib/money"');

const SUMMARY_V2 = swap(
  SUMMARY_V1,
  src(`
        <dd>{formatPrice(totals.subtotal)}</dd>
      </div>
`),
  src(`
        <dd>{formatPrice(totals.subtotal)}</dd>
      </div>
      {totals.discount > 0 && (
        <div className="summary-row summary-discount">
          <dt>Discount</dt>
          <dd>−{formatPrice(totals.discount)}</dd>
        </div>
      )}
`),
);

const PROMO_FIELD = src(`
import { FormEvent, useState } from "react";

type Status =
  | { state: "idle" }
  | { state: "applying" }
  | { state: "applied"; code: string }
  | { state: "error"; message: string };

const MESSAGES: Record<string, string> = {
  not_found: "We couldn't find that code.",
  not_started: "This code isn't active yet.",
  expired: "This code has expired.",
  below_minimum: "Add a little more to your cart to use this code.",
  fully_redeemed: "This code has been used up.",
};

interface Props {
  onApply(code: string): Promise<{ ok: true; code: string } | { ok: false; reason: string }>;
  onRemove(): void;
}

export function PromoCodeField({ onApply, onRemove }: Props) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;

    setStatus({ state: "applying" });
    const result = await onApply(code);
    setStatus(
      result.ok
        ? { state: "applied", code: result.code }
        : { state: "error", message: MESSAGES[result.reason] ?? "That code didn't work." },
    );
  }

  function remove() {
    setCode("");
    setStatus({ state: "idle" });
    onRemove();
  }

  if (status.state === "applied") {
    return (
      <div className="promo promo-applied" role="status">
        <span>
          <strong>{status.code}</strong> applied
        </span>
        <button type="button" onClick={remove}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <form className="promo" onSubmit={apply}>
      <label htmlFor="promo-code">Promo code</label>
      <div className="promo-row">
        <input
          id="promo-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          aria-invalid={status.state === "error"}
          aria-describedby={status.state === "error" ? "promo-error" : undefined}
        />
        <button type="submit" disabled={status.state === "applying"}>
          {status.state === "applying" ? "Applying…" : "Apply"}
        </button>
      </div>
      {status.state === "error" && (
        <p id="promo-error" className="promo-error">
          {status.message}
        </p>
      )}
    </form>
  );
}
`);

/* ---------- History ---------- */

const MAIN_FILES: Record<string, string> = {
  "README.md": README,
  "CHANGELOG.md": CHANGELOG_V0,
  "package.json": packageJson("1.7.0"),
  "package-lock.json": packageLock("1.7.0"),
  "tsconfig.json": TSCONFIG,
  ".github/workflows/ci.yml": CI_YML,
  "scripts/check-migrations.sh": CHECK_MIGRATIONS,
  "src/utils/currency.ts": CURRENCY,
  "src/cart/cart.ts": CART_V0,
  "src/cart/cart.test.ts": CART_TEST,
  "src/checkout/checkout.ts": CHECKOUT_V0,
  "src/payments/charge.ts": CHARGE_V0,
  "src/payments/provider.ts": PROVIDER,
  "src/db/sql.ts": SQL_TS,
  "src/db/repository.ts": REPOSITORY_TS,
  "src/db/index.ts": DB_INDEX_V0,
  "src/db/migrations/0006_saved_carts.sql": MIGRATION_0006,
  "web/components/CheckoutSummary.tsx": SUMMARY_V0,
};

interface Commit {
  branch: string;
  author: keyof typeof PEOPLE;
  date: string;
  message: string;
  /** New file contents by path; null deletes the file. */
  changes: Record<string, string | null>;
}

const HISTORY: Commit[] = [
  { branch: "main", author: "priya", date: "2026-08-18T10:12:00-07:00", message: "Initial storefront: cart, checkout and payments", changes: MAIN_FILES },
  {
    branch: "main",
    author: "jordan",
    date: "2026-08-27T15:03:00-07:00",
    message:
      "Add code owners\n\n" +
      "Platform owns the repository by default; payments, migrations and web/ get\n" +
      "their own owners.",
    changes: { ".github/CODEOWNERS": CODEOWNERS },
  },
  {
    branch: "main",
    author: "leo",
    date: "2026-09-02T11:40:00-07:00",
    message: "Release 1.8.0",
    changes: { "CHANGELOG.md": CHANGELOG_V1, "package.json": packageJson("1.8.0"), "package-lock.json": packageLock("1.8.0") },
  },
  {
    branch: "feature/promo-codes",
    author: "maya",
    date: "2026-09-22T16:40:00-07:00",
    message: "Add promo code model and migration\n\n" + "Moves src/utils/currency.ts to src/lib/money.ts and adds percentOf().",
    changes: {
      "src/utils/currency.ts": null,
      "src/lib/money.ts": MONEY,
      "src/promotions/promo.ts": PROMO_V1,
      "src/db/migrations/0007_promo_codes.sql": MIGRATION_0007,
      "src/db/index.ts": DB_INDEX_V1,
      "src/cart/cart.ts": swap(CART_V0, '"../utils/currency"', '"../lib/money"'),
      "src/payments/charge.ts": CHARGE_V1,
      "web/components/CheckoutSummary.tsx": SUMMARY_V1,
    },
  },
  {
    branch: "feature/promo-codes",
    author: "maya",
    date: "2026-09-23T10:05:00-07:00",
    message: "Apply promo discounts to cart totals",
    changes: { "src/cart/cart.ts": CART_V2, "src/promotions/promo.test.ts": PROMO_TEST_V1 },
  },
  {
    branch: "feature/promo-codes",
    author: "maya",
    date: "2026-09-23T15:30:00-07:00",
    message: "Accept promo codes in the checkout API",
    changes: {
      "src/checkout/checkout.ts": CHECKOUT_V1,
      "src/payments/charge.ts": CHARGE_V2,
      "package.json": packageJson("1.8.0", true),
      "package-lock.json": packageLock("1.8.0", true, "5.6.3"),
    },
  },
  {
    branch: "feature/promo-codes",
    author: "maya",
    date: "2026-09-25T10:20:00-07:00",
    message:
      "Clamp discounts and normalize codes\n\n" +
      "Review feedback on #248:\n" +
      "- discountFor() never returns more than the subtotal\n" +
      "- chargeCustomer() refuses zero, negative and fractional amounts\n" +
      "- codes are trimmed and uppercased before lookup",
    changes: {
      "src/promotions/promo.ts": PROMO_V2,
      "src/payments/charge.ts": CHARGE_V3,
      "src/checkout/checkout.ts": CHECKOUT_V2,
      "src/promotions/promo.test.ts": PROMO_TEST_V2,
    },
  },
  {
    branch: "feature/promo-codes",
    author: "maya",
    date: "2026-09-25T15:35:00-07:00",
    message: "Add promo code field to checkout",
    changes: { "web/components/PromoCodeField.tsx": PROMO_FIELD, "web/components/CheckoutSummary.tsx": SUMMARY_V2, "CHANGELOG.md": CHANGELOG_V2 },
  },
];

/** Index in HISTORY of the commit the reviewer last looked at: "Accept promo codes in the checkout API". */
const LAST_REVIEWED = 5;

/* ---------- Building ---------- */

// Settings that would otherwise come from the user's git config and change the commits.
const GIT = ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false"];

function gitEnv(person: keyof typeof PEOPLE | null, date: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  // A git hook running the tests sets these; they'd point the commands at the outer repository.
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  if (person && date) {
    const [name, email] = PEOPLE[person];
    Object.assign(env, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    });
  }
  return env;
}

function git(cwd: string, args: string[], env = gitEnv(null, null)): string {
  return execFileSync(GIT[0], [...GIT.slice(1), ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function looksLikeSample(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git")) && readFileSync(join(dir, "README.md"), "utf8").includes("Juniper Shop");
  } catch {
    return false;
  }
}

/** Write the history into an empty folder. */
function writeHistory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  HISTORY.forEach((c, index) => {
    if (index > 0 && c.branch !== git(dir, ["branch", "--show-current"])) git(dir, ["checkout", "-q", "-b", c.branch]);
    for (const [file, content] of Object.entries(c.changes)) {
      const target = join(dir, file);
      if (content === null) {
        unlinkSync(target);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      if (file.endsWith(".sh")) chmodSync(target, 0o755);
    }
    const env = gitEnv(c.author, c.date);
    git(dir, ["add", "-A"], env);
    git(dir, ["commit", "-q", "-m", c.message], env);
    if (index === LAST_REVIEWED) git(dir, ["tag", "last-review"], env);
  });
}

/**
 * Build the sample repository at `target`. An existing one is kept unless `force` is set.
 * Safe to call from several processes at once: each builds in a folder of its own and
 * moves it into place, and the first one there wins.
 */
export function buildSampleRepo(target: string = SAMPLE_REPO, { force = false } = {}): { built: boolean; path: string } {
  target = resolve(target);
  if (existsSync(target)) {
    if (!looksLikeSample(target)) throw new Error(`${target} doesn't look like the generated sample repository; not touching it.`);
    if (!force) return { built: false, path: target };
    rmSync(target, { recursive: true, force: true });
  }
  const tmp = join(dirname(target), `${basename(target)}.building-${process.pid}-${Date.now()}`);
  try {
    writeHistory(tmp);
    try {
      renameSync(tmp, target);
    } catch (e) {
      // Another process built it first.
      if (!looksLikeSample(target)) throw e;
      return { built: false, path: target };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { built: true, path: target };
}

/** The sample repository's path, built first if it's missing. */
export function ensureSampleRepo(target: string = SAMPLE_REPO): string {
  return buildSampleRepo(target).path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { force: { type: "boolean", default: false } } });
  const { built, path } = buildSampleRepo(positionals[0] ?? SAMPLE_REPO, { force: values.force });
  if (!built) {
    console.log(`${path} already exists. Run with --force to rebuild it.`);
  } else {
    console.log(`Built ${path} with ${HISTORY.length} commits.`);
    console.log(git(path, ["log", "--oneline", "--graph", "--all", "--decorate"]));
  }
}
