/* Tizon Books 1.19.0 · server function, in one file. Built from
   netlify/functions/books-mail.mjs and netlify/lib/*.mjs. */
// netlify/functions/books-mail.mjs
import { createRemoteJWKSet, jwtVerify } from "jose";
import nodemailer from "nodemailer";
import { PDFDocument as PDFDocument2 } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { getStore } from "@netlify/blobs";
import forge from "node-forge";

// netlify/lib/pay.mjs
import { createHash, randomBytes } from "node:crypto";
var r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
var rateOf = (book) => book?.dealerType === "exempt" ? 0 : Number(book?.vatRate) || 0;
var digitsOf = (v) => String(v || "").replace(/\D/g, "");
var token = (n = 16) => randomBytes(n).toString("hex");
var sha = (s) => createHash("sha256").update(String(s)).digest("hex");
var ALLOC_THRESHOLD = 5e3;
var israelDate = (at = /* @__PURE__ */ new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
function totals(lines, incl, rate) {
  const sum = r2((lines || []).reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
  if (!rate) return { net: sum, vat: 0, total: sum };
  if (incl) {
    const net = r2(sum / (1 + rate / 100));
    return { net, vat: r2(sum - net), total: sum };
  }
  const vat = r2(sum * rate / 100);
  return { net: sum, vat, total: r2(sum + vat) };
}
function stampOf(d) {
  const core = JSON.stringify([d.type, d.series, "?", d.date, d.customer?.name, d.customer?.taxId, d.total, d.vat, d.lines, d.payments]);
  return createHash("sha256").update(core).digest("hex").slice(0, 10).toUpperCase();
}
var seriesOf = (book) => book.docMode === "live" && book.docApproved ? "live" : "test";
var payDocType = (book) => rateOf(book) > 0 ? "320" : "400";
var roleIn = (book, email) => {
  const e = String(email || "").toLowerCase();
  if ((book.owners || []).map((x) => x.toLowerCase()).includes(e)) return "owner";
  if ((book.clerks || []).map((x) => x.toLowerCase()).includes(e)) return "clerk";
  if ((book.viewers || []).map((x) => x.toLowerCase()).includes(e)) return "viewer";
  return "";
};
function adminAdapter(fs) {
  const ref = (p) => fs.doc(p);
  return {
    get: async (p) => {
      const s = await ref(p).get();
      return s.exists ? { ...s.data(), id: s.id } : null;
    },
    set: (p, d) => ref(p).set(d),
    update: (p, d) => ref(p).update(d),
    list: async (col, field, val) => (await (field ? fs.collection(col).where(field, "==", val) : fs.collection(col)).get()).docs.map((x) => ({ ...x.data(), id: x.id })),
    tx: (fn) => fs.runTransaction((t) => fn({
      get: async (p) => {
        const s = await t.get(ref(p));
        return s.exists ? { ...s.data(), id: s.id } : null;
      },
      set: (p, d) => t.set(ref(p), d),
      update: (p, d) => t.update(ref(p), d)
    }))
  };
}
var ZC_URL = "https://pci.zcredit.co.il/webcheckout/api/WebCheckout/CreateSession";
async function zcSession({ key, pay, base, secret, fetchImpl = fetch, url = ZC_URL }) {
  const q = (o) => new URLSearchParams(o).toString();
  const fn = `${base}/.netlify/functions/books-mail`;
  const rate = Number(pay.vatRate) || 0;
  const items = (pay.lines || []).map((l) => {
    const unit = pay.incl || !rate ? Number(l.price) || 0 : (Number(l.price) || 0) * (1 + rate / 100);
    return {
      Name: String(l.desc || "\u05E4\u05E8\u05D9\u05D8").slice(0, 100),
      Description: String(l.sku || ""),
      Quantity: Number(l.qty) || 1,
      Amount: r2(unit).toFixed(2),
      Currency: "ILS",
      Image: "",
      IsTaxFree: rate ? "false" : "true"
    };
  });
  const sum = r2(items.reduce((a, x) => a + Number(x.Amount) * x.Quantity, 0));
  const cart = Math.abs(sum - r2(pay.total)) < 0.011 ? items : [{ Name: String(pay.title || "\u05EA\u05E9\u05DC\u05D5\u05DD").slice(0, 100), Description: "", Quantity: 1, Amount: r2(pay.total).toFixed(2), Currency: "ILS", Image: "", IsTaxFree: rate ? "false" : "true" }];
  const max = Math.max(1, Math.min(36, Number(pay.maxPayments) || 1));
  const body = {
    Key: key,
    Local: "He",
    UniqueId: pay.id,
    SuccessUrl: `${fn}?${q({ action: "pay-done", b: pay.book, p: pay.id })}`,
    CancelUrl: `${fn}?${q({ action: "pay-done", b: pay.book, p: pay.id, cancel: "1" })}`,
    CallbackUrl: `${fn}?${q({ action: "pay-callback", b: pay.book, p: pay.id, t: secret })}`,
    PaymentType: "regular",
    CreateInvoice: "false",
    ShowCart: "true",
    AdditionalText: String(pay.note || "").slice(0, 200),
    Installments: { Type: max > 1 ? "regular" : "none", MinQuantity: 1, MaxQuantity: max },
    Customer: {
      Email: pay.customer?.email || "",
      Name: pay.customer?.name || "",
      PhoneNumber: pay.customer?.phone || "",
      Attributes: { HolderId: "optional", Name: "required", PhoneNumber: "optional", Email: pay.customer?.email ? "optional" : "required" }
    },
    CartItems: cart
  };
  const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const data = j.Data || j.data || {};
  if (!r.ok || j.HasError || data.HasError || !data.SessionUrl) {
    throw Object.assign(new Error("zcredit: " + (data.ReturnMessage || j.ReturnMessage || j.Message || r.status)), { status: 502 });
  }
  return { sessionId: data.SessionId || "", url: data.SessionUrl };
}
/* uPay, the second clearing company a payment page can use. Its API takes a
   login and a request in one message (as uPay's own WooCommerce plugin sends
   them): a page for this payment, and later the transaction itself, asked for
   before any document is issued — what uPay puts in the return address is
   not proof. Needs the account's email and API key. */
var UP_URL = "https://app.upay.co.il/API6/clientsecure/json.php";
async function upCall(creds, request, fetchImpl = fetch) {
  const header = { refername: "UPAY", livesystem: 1, language: "HE" };
  const msgs = [
    { header, request: { mainaction: "CONNECTION", minoraction: "LOGIN", encoding: "json", parameters: { email: creds.email, key: creds.key } } },
    { header, request: { encoding: "json", ...request } }
  ];
  const r = await fetchImpl(UP_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ msgs: JSON.stringify(msgs) }).toString() });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return null; }
}
var upDesc = (pay) => {
  /* One line, without quotes: uPay's page carries the description in its own
     script, and a line break there stops its pay button from answering. */
  const clean = (v) => String(v || "").replace(/[\r\n\t]+/g, " ").replace(/['"`\\<>{}]/g, "").replace(/\s+/g, " ").trim();
  const lines = (pay.lines || []).map((l) => `${clean(l.desc).slice(0, 60)}${Number(l.qty) > 1 ? " x" + l.qty : ""}`);
  return clean([`${clean(pay.title).slice(0, 60)} ${pay.id}`, ...lines].join(" | ")).slice(0, 190);
};
async function upSession({ creds, pay, base, secret, fetchImpl = fetch }) {
  const fn = `${base}/.netlify/functions/books-mail`;
  const q = (o) => new URLSearchParams(o).toString();
  const back = `${fn}?${q({ action: "pay-up", b: pay.book, p: pay.id, t: secret })}`;
  const phone = String(pay.customer?.phone || "").replace(/[^\d+]/g, "");
  const transfer = {
    email: creds.email, commissionreduction: 0, amount: r2(pay.total), currency: "NIS",
    maxpayments: Math.max(1, Math.min(36, Number(pay.maxPayments) || 1)),
    paymentdate: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    productdescription: upDesc(pay), returnurl: back, ipnurl: back + "&ipn=1",
    ...(/^(05|\+9725)/.test(phone) ? { cellphonenotify: phone.replace(/^\+972/, "0") } : {}),
    ...(pay.customer?.email ? { emailnotify: pay.customer.email } : {})
  };
  const res = await upCall(creds, { mainaction: "CASHIER", minoraction: "REDIRECTDEPOSITCREDITCARDTRANSFER", numbertemplate: 15,
    parameters: { transfers: [transfer], foreign: "0", key: creds.key, cardreader: "0", creditcardcompanytype: "ISR", creditcardtype: "PR" } }, fetchImpl);
  const url = res?.results?.[1]?.result?.transactions?.[0]?.url;
  if (!url || !/^https:\/\//i.test(url)) throw Object.assign(new Error("upay: " + String(res?.results?.[1]?.result?.errordescription || res?.results?.[1]?.errormessage || "no page").slice(0, 160)), { status: 502 });
  return { url };
}
/* The transaction as uPay itself reports it, turned into the shape the
   payment-page callback reads — or null when uPay does not confirm it. */
async function upVerify({ creds, pay, trx, fetchImpl = fetch }) {
  const res = await upCall(creds, { mainaction: "TRANSACTIONSINFO", minoraction: "GETTRANSACTIONS", parameters: { cashierids: [trx] } }, fetchImpl);
  const t = res?.results?.[1]?.result?.sendertransactions?.[0];
  if (!t) return null;
  const st = String(t.transferstatus || "").toUpperCase();
  const desc = String(t.productdescription ?? t.paymentdetails ?? "");
  if (!["S", "A"].includes(st) || (desc && !desc.includes(pay.id))) return null;
  return { UniqueID: pay.id, ReferenceNumber: String(trx), Total: t.amount ?? pay.total,
           ApprovalNumber: String(t.approvalnumber || t.authnumber || ""), CardNum: String(t.cardnumber || t.last4digits || ""),
           Installments: t.numberpayments || t.payments || 1, CustomerName: String(t.sendername || t.name || "") };
}
function readCallback(b) {
  const pick2 = (...ks) => {
    for (const k of ks) if (b?.[k] != null && b[k] !== "") return b[k];
    return "";
  };
  const last4 = String(pick2("CardNum", "CardNumber", "Last4Digits", "CardSuffix")).replace(/\D/g, "").slice(-4);
  const total = pick2("Total", "TransactionSum", "Amount", "Sum");
  return {
    error: !!(b?.HasError === true || b?.HasError === "true"),
    sessionId: String(pick2("SessionId", "SessionID", "Guid")),
    uniqueId: String(pick2("UniqueID", "UniqueId")),
    reference: String(pick2("ReferenceNumber", "ReferenceID", "TransactionID")),
    approval: String(pick2("ApprovalNumber", "AuthNum", "ApprovalNum")),
    last4,
    installments: Number(pick2("Installments", "NumOfPayments", "PaymentsNumber")) || 1,
    j: String(pick2("J")),
    total: total === "" ? null : r2(total),
    card: String(pick2("CardName", "CardBrand", "Brand")),
    name: String(pick2("CustomerName", "HolderName")),
    email: String(pick2("CustomerEmail", "Email")),
    phone: String(pick2("CustomerPhone", "PhoneNumber")),
    holderId: String(pick2("HolderId", "HolderID"))
  };
}
async function issueForPayment(db, bookId, payId, cb, { now = /* @__PURE__ */ new Date(), version = "" } = {}) {
  const bookPath = `books/${bookId}`, payPath = `${bookPath}/payreqs/${payId}`;
  const book0 = await db.get(bookPath);
  if (!book0) return { skip: "no-book" };
  const series = seriesOf(book0), type = payDocType(book0);
  const have = (await db.list(`${bookPath}/documents`, "series", series)).filter((d) => d.type === type).map((d) => Number(d.number) || 0);
  const start = Math.max(series === "live" ? Number(book0.docStart) || 1 : 1, have.length ? Math.max(...have) + 1 : 0);
  return db.tx(async (t) => {
    const pay = await t.get(payPath);
    if (!pay) return { skip: "no-page" };
    if (pay.status === "paid") return { already: pay.docId };
    if (pay.status !== "open") return { skip: pay.status };
    const book = await t.get(bookPath);
    const ck = `${bookPath}/counters/${series}_${type}`;
    const counter = await t.get(ck);
    const n = Math.max(counter ? Number(counter.next) || 0 : 0, start);
    const date = israelDate(now);
    const rate = type === "400" ? 0 : Number(pay.vatRate) || 0;
    const card = [cb.last4 ? `**** ${cb.last4}` : "", cb.installments > 1 ? `${cb.installments} \u05EA\u05E9\u05DC\u05D5\u05DE\u05D9\u05DD` : "", cb.approval ? `\u05D0\u05D9\u05E9\u05D5\u05E8 ${cb.approval}` : ""].filter(Boolean).join(" \xB7 ");
    const customer = {
      name: pay.customer?.name || cb.name || "\u05DC\u05E7\u05D5\u05D7",
      taxId: pay.customer?.taxId || cb.holderId || "",
      address: pay.customer?.address || "",
      phone: pay.customer?.phone || cb.phone || "",
      email: pay.customer?.email || cb.email || ""
    };
    const lines = type === "400" ? [] : (pay.lines || []).map((l) => ({ desc: l.desc, qty: Number(l.qty) || 0, price: r2(l.price), ...l.itemId ? { itemId: l.itemId, sku: l.sku || "" } : {} }));
    const tot = type === "400" ? { net: r2(pay.total), vat: 0, total: r2(pay.total) } : totals(lines, !!pay.incl, rate);
    const forWhat = type === "400" ? (pay.lines || []).map((l) => `${l.desc}${Number(l.qty) !== 1 ? " \xD7 " + l.qty : ""}`).join(", ") : "";
    const rec = {
      id: "doc_" + now.getTime().toString(36) + token(3),
      type,
      series,
      date,
      customer,
      lines,
      incl: type === "400" ? false : !!pay.incl,
      vatRate: type === "400" ? 0 : rate,
      net: tot.net,
      vat: tot.vat,
      total: tot.total,
      payments: [{ kind: "\u05DB\u05E8\u05D8\u05D9\u05E1 \u05D0\u05E9\u05E8\u05D0\u05D9", amount: tot.total, date, details: card }],
      allocationNo: "",
      notes: [forWhat ? "\u05E2\u05D1\u05D5\u05E8: " + forWhat : "", pay.note || "", pay.provider === "upay" ? "\u05E9\u05D5\u05DC\u05DD \u05D1\u05D3\u05E3 \u05E1\u05DC\u05D9\u05E7\u05D4 (\u05D9\u05D5\u05E4\u05D9\u05D9)" : "\u05E9\u05D5\u05DC\u05DD \u05D1\u05D3\u05E3 \u05E1\u05DC\u05D9\u05E7\u05D4 (\u05D6\u05D3 \u05E7\u05E8\u05D3\u05D9\u05D8)"].filter(Boolean).join(" \xB7 "),
      withholding: 0,
      createdBy: pay.createdBy || (pay.provider === "upay" ? "upay" : "zcredit"),
      refId: "",
      refTitle: "",
      printCount: 0,
      createdAt: now.toISOString(),
      payId,
      payRef: cb.reference || "",
      via: pay.provider === "upay" ? "upay" : "zcredit"
    };
    rec.stamp = stampOf(rec);
    const d = { ...rec, number: n };
    t.set(ck, { next: n + 1 });
    t.set(`${bookPath}/documents/${d.id}`, d);
    t.update(payPath, {
      status: "paid",
      paidAt: now.toISOString(),
      docId: d.id,
      docNo: (series === "test" ? "T-" : "") + n,
      docType: type,
      docSeries: series,
      zc: { reference: cb.reference, approval: cb.approval, last4: cb.last4, installments: cb.installments, sessionId: cb.sessionId }
    });
    return { doc: d, book: book || book0, pay };
  });
}
function itaInvoice(book, d) {
  const rate = Number(d.vatRate) || 0;
  return {
    invoice_id: d.id,
    invoice_type: Number(d.type),
    vat_number: Number(digitsOf(book.taxId)),
    user_name: String(d.createdBy || "").slice(0, 25),
    invoice_reference_number: String(d.number),
    customer_vat_number: Number(digitsOf(d.customer?.taxId)),
    customer_name: String(d.customer?.name || "").slice(0, 25),
    invoice_date: d.date,
    invoice_issuance_date: d.date,
    accounting_software_number: Number(digitsOf(book.software?.regNo)) || 0,
    amount_before_discount: r2(d.net),
    discount: 0,
    payment_amount: r2(d.net),
    vat_amount: r2(d.vat),
    payment_amount_including_vat: r2(d.total),
    items_list: (d.lines || []).map((l, i) => {
      const unit = d.incl && rate ? (Number(l.price) || 0) / (1 + rate / 100) : Number(l.price) || 0;
      const net = r2(unit * (Number(l.qty) || 0));
      return {
        index: i + 1,
        description: String(l.desc || "").slice(0, 30),
        quantity: Number(l.qty) || 0,
        price_per_unit: r2(unit),
        discount: 0,
        total_amount: net,
        vat_rate: rate,
        vat_amount: r2(net * rate / 100)
      };
    })
  };
}
var needsAlloc = (book, d) => d.series === "live" && ["305", "320"].includes(d.type) && rateOf(book) > 0 && digitsOf(d.customer?.taxId).length === 9 && (Number(d.net) || 0) > ALLOC_THRESHOLD;
var logRec = (entry, now) => ({ id: "log_" + now.getTime().toString(36) + token(3), at: now.toISOString(), user: "zcredit", ...entry });
var heDate = (s) => String(s || "").split("-").reverse().join("/");
var money = (n) => "\u20AA" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
var LABEL = { 320: "\u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA \u05DE\u05E1 \u05E7\u05D1\u05DC\u05D4", 400: "\u05E7\u05D1\u05DC\u05D4" };
async function handleCallback({ bookId, payId, secret, body }, deps) {
  const now = deps.now || /* @__PURE__ */ new Date();
  const kept = await deps.secretOf(bookId, payId);
  if (!kept || !secret || sha(secret) !== sha(kept)) return { status: 403, error: "secret" };
  const cb = readCallback(body);
  const payPath = `books/${bookId}/payreqs/${payId}`;
  const pay = await deps.db.get(payPath);
  if (!pay) return { status: 404, error: "no-page" };
  if (cb.error) {
    await deps.db.update(payPath, { lastError: { at: now.toISOString(), body: JSON.stringify(body).slice(0, 2e3) } });
    return { status: 200, ok: false, error: "declined" };
  }
  if (cb.uniqueId && cb.uniqueId !== payId) return { status: 400, error: "unique-id" };
  if (cb.total != null && Math.abs(cb.total - r2(pay.total)) > 0.011) {
    await deps.db.update(payPath, { status: pay.status === "open" ? "mismatch" : pay.status, mismatch: { at: now.toISOString(), paid: cb.total, reference: cb.reference } });
    await deps.mail?.({
      to: pay.createdBy,
      subject: `Tizon Books \xB7 \u05EA\u05E9\u05DC\u05D5\u05DD \u05D1\u05E1\u05DB\u05D5\u05DD \u05E9\u05D5\u05E0\u05D4 (${money(cb.total)})`,
      text: `\u05D3\u05E3 \u05D4\u05E1\u05DC\u05D9\u05E7\u05D4 \u05E9\u05DC ${pay.customer?.name || ""} \u05E2\u05DC ${money(pay.total)} \u05E9\u05D5\u05DC\u05DD \u05D1\u05E1\u05DB\u05D5\u05DD ${money(cb.total)} (\u05D0\u05E1\u05DE\u05DB\u05EA\u05D0 ${cb.reference}).
\u05DC\u05D0 \u05D4\u05D5\u05E4\u05E7 \u05DE\u05E1\u05DE\u05DA. \u05DB\u05D3\u05D0\u05D9 \u05DC\u05D1\u05D3\u05D5\u05E7 \u05D1\u05DE\u05DE\u05E9\u05E7 \u05E9\u05DC \u05D6\u05D3 \u05E7\u05E8\u05D3\u05D9\u05D8.`
    }).catch(() => {
    });
    return { status: 200, ok: false, error: "amount" };
  }
  const res = await issueForPayment(deps.db, bookId, payId, cb, { now, version: deps.version });
  if (res.already) {
    if (cb.reference && cb.reference !== pay.zc?.reference) {
      await deps.db.update(payPath, { extraPayments: [...pay.extraPayments || [], { at: now.toISOString(), reference: cb.reference, total: cb.total, last4: cb.last4 }] });
      await deps.mail?.({
        to: pay.createdBy,
        subject: "Tizon Books \xB7 \u05EA\u05E9\u05DC\u05D5\u05DD \u05DB\u05E4\u05D5\u05DC \u05D1\u05D3\u05E3 \u05E1\u05DC\u05D9\u05E7\u05D4",
        text: `\u05D3\u05E3 \u05D4\u05E1\u05DC\u05D9\u05E7\u05D4 \u05E9\u05DC ${pay.customer?.name || ""} \u05E9\u05D5\u05DC\u05DD \u05E4\u05E2\u05DD \u05E0\u05D5\u05E1\u05E4\u05EA (\u05D0\u05E1\u05DE\u05DB\u05EA\u05D0 ${cb.reference}). \u05D4\u05DE\u05E1\u05DE\u05DA \u05D4\u05D5\u05E4\u05E7 \u05E4\u05E2\u05DD \u05D0\u05D7\u05EA. \u05DB\u05D3\u05D0\u05D9 \u05DC\u05D6\u05DB\u05D5\u05EA \u05D0\u05EA \u05D4\u05D7\u05D9\u05D5\u05D1 \u05D4\u05E0\u05D5\u05E1\u05E3 \u05D1\u05D6\u05D3 \u05E7\u05E8\u05D3\u05D9\u05D8.`
      }).catch(() => {
      });
    }
    return { status: 200, ok: true, docId: res.already, again: true };
  }
  if (!res.doc) return { status: 200, ok: false, error: res.skip };
  const { doc, book } = res;
  const docsPath = `books/${bookId}/documents`, logPath = `books/${bookId}/log`;
  const title = `${LABEL[doc.type] || "\u05DE\u05E1\u05DE\u05DA"} ${(doc.series === "test" ? "T-" : "") + doc.number}`;
  const log = async (e) => {
    const r = logRec(e, /* @__PURE__ */ new Date());
    await deps.db.set(`${logPath}/${r.id}`, r).catch(() => {
    });
  };
  await log({ action: "issue", docId: doc.id, title: `${title} \xB7 ${money(doc.total)} \xB7 \u05D3\u05E3 \u05E1\u05DC\u05D9\u05E7\u05D4`, series: doc.series });
  if (deps.ita && needsAlloc(book, doc)) {
    try {
      const r = await deps.ita(itaInvoice(book, doc));
      if (r?.approved && r.confirmation_number && r.confirmation_number !== "0") {
        doc.allocationNo = String(r.confirmation_number);
        doc.allocationAt = (/* @__PURE__ */ new Date()).toISOString();
        await deps.db.update(`${docsPath}/${doc.id}`, { allocationNo: doc.allocationNo, allocationAt: doc.allocationAt });
        await log({ action: "allocation", docId: doc.id, title: `${title} \xB7 ${doc.allocationNo.slice(-9)}`, series: doc.series });
      }
    } catch {
    }
  }
  try {
    const cs = await deps.db.list(`books/${bookId}/customers`);
    const e = String(doc.customer.email || "").toLowerCase(), p = digitsOf(doc.customer.phone).slice(-9), tx = digitsOf(doc.customer.taxId);
    const hit = cs.find((c) => tx && digitsOf(c.taxId) === tx || e && String(c.email || "").toLowerCase() === e || p.length === 9 && digitsOf(c.phone).slice(-9) === p);
    if (!hit) {
      const id = "cust_" + now.getTime().toString(36) + token(2);
      await deps.db.set(`books/${bookId}/customers/${id}`, {
        id,
        name: doc.customer.name,
        taxId: doc.customer.taxId || "",
        phone: doc.customer.phone || "",
        email: doc.customer.email || "",
        address: doc.customer.address || "",
        sources: ["doc"],
        createdAt: now.toISOString()
      });
    }
  } catch {
  }
  let sent = "";
  if (doc.customer.email && deps.mail && deps.sign) {
    try {
      const raw = await deps.pdf(book, doc, { version: deps.version });
      const signed = await deps.sign(raw, { name: book.legalName || book.name, contact: book.email || "", reason: title });
      const file = `${doc.type === "400" ? "receipt" : "tax-invoice-receipt"}-${(doc.series === "test" ? "T-" : "") + doc.number}.pdf`;
      await deps.mail({
        to: doc.customer.email,
        replyTo: book.email || void 0,
        subject: `${title} \xB7 ${book.legalName || book.name}`,
        text: `\u05E9\u05DC\u05D5\u05DD ${doc.customer.name},

\u05EA\u05D5\u05D3\u05D4 \u05E2\u05DC \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD. \u05DE\u05E6\u05D5\u05E8\u05E4\u05EA ${title} \u05E2\u05DC \u05E1\u05DA ${money(doc.total)}, \u05D7\u05EA\u05D5\u05DE\u05D4 \u05D3\u05D9\u05D2\u05D9\u05D8\u05DC\u05D9\u05EA.

${book.legalName || book.name}`,
        attachments: [{ filename: file, content: signed, contentType: "application/pdf" }]
      });
      sent = doc.customer.email;
      const at = (/* @__PURE__ */ new Date()).toISOString();
      await deps.db.update(`${docsPath}/${doc.id}`, { printCount: 1, sentAt: at, sentTo: sent });
      await log({ action: "send", docId: doc.id, title: `${title} \u2190 ${sent}`, series: doc.series });
    } catch (e) {
      await log({ action: "send-failed", docId: doc.id, title: `${title} \xB7 ${String(e.message || e).slice(0, 120)}`, series: doc.series });
    }
  }
  if (deps.mail && pay.createdBy && pay.createdBy.includes("@")) {
    await deps.mail({
      to: pay.createdBy,
      subject: `Tizon Books \xB7 \u05D4\u05EA\u05E7\u05D1\u05DC \u05EA\u05E9\u05DC\u05D5\u05DD ${money(doc.total)} \u05DE${doc.customer.name}`,
      text: `${book.name}: ${doc.customer.name} \u05E9\u05D9\u05DC\u05DD ${money(doc.total)} \u05D1\u05D3\u05E3 \u05D4\u05E1\u05DC\u05D9\u05E7\u05D4 (${heDate(doc.date)}).
\u05D4\u05D5\u05E4\u05E7\u05D4 ${title}${sent ? ` \u05D5\u05E0\u05E9\u05DC\u05D7\u05D4 \u05DC-${sent}` : ". \u05D4\u05D9\u05D0 \u05DC\u05D0 \u05E0\u05E9\u05DC\u05D7\u05D4 \u05DC\u05DC\u05E7\u05D5\u05D7: " + (doc.customer.email ? "\u05D0\u05D9\u05DF \u05EA\u05E2\u05D5\u05D3\u05EA \u05D7\u05EA\u05D9\u05DE\u05D4 \u05D0\u05D5 \u05DE\u05D9\u05D9\u05DC \u05D1\u05E9\u05E8\u05EA" : "\u05D0\u05D9\u05DF \u05DC\u05D5 \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC")}.`
    }).catch(() => {
    });
  }
  return { status: 200, ok: true, docId: doc.id, number: doc.number, sent };
}
function donePage({ pay, book, cancel }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const biz = esc(book?.legalName || book?.name || "");
  let head, body, refresh = false;
  if (!pay) {
    head = "\u05D4\u05D3\u05E3 \u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0";
    body = "\u05D9\u05D9\u05EA\u05DB\u05DF \u05E9\u05D4\u05E7\u05D9\u05E9\u05D5\u05E8 \u05E9\u05D2\u05D5\u05D9.";
  } else if (cancel && pay.status === "open") {
    head = "\u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05DC\u05D0 \u05D4\u05D5\u05E9\u05DC\u05DD";
    body = "\u05DC\u05D0 \u05D1\u05D5\u05E6\u05E2 \u05D7\u05D9\u05D5\u05D1. \u05D0\u05E4\u05E9\u05E8 \u05DC\u05D7\u05D6\u05D5\u05E8 \u05DC\u05E7\u05D9\u05E9\u05D5\u05E8 \u05E9\u05E9\u05DC\u05D7\u05E0\u05D5 \u05D5\u05DC\u05E0\u05E1\u05D5\u05EA \u05E9\u05D5\u05D1.";
  } else if (pay.status === "paid") {
    head = "\u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05D4\u05EA\u05E7\u05D1\u05DC, \u05EA\u05D5\u05D3\u05D4!";
    body = `${esc(pay.docNo ? (LABEL[pay.docType] || "\u05D4\u05DE\u05E1\u05DE\u05DA") + " " + pay.docNo : "\u05D4\u05DE\u05E1\u05DE\u05DA")} ${pay.customer?.email ? `\u05E0\u05E9\u05DC\u05D7\u05D4 \u05DC\u05DB\u05EA\u05D5\u05D1\u05EA ${esc(pay.customer.email)}` : "\u05D4\u05D5\u05E4\u05E7\u05D4"}.`;
  } else if (pay.status === "open" && pay.upReport) {
    head = "\u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05D4\u05EA\u05E7\u05D1\u05DC, \u05EA\u05D5\u05D3\u05D4!";
    body = "\u05D4\u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA \u05EA\u05D9\u05E9\u05DC\u05D7 \u05D0\u05DC\u05D9\u05DA \u05D1\u05E7\u05E8\u05D5\u05D1.";
  } else if (pay.status === "open") {
    head = "\u05DE\u05E2\u05D3\u05DB\u05E0\u05D9\u05DD \u05D0\u05EA \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD\u2026";
    body = "\u05E8\u05E7 \u05E8\u05D2\u05E2, \u05D4\u05D3\u05E3 \u05D9\u05EA\u05E2\u05D3\u05DB\u05DF \u05DC\u05D1\u05D3.";
    refresh = true;
  } else if (pay.status === "cancelled") {
    head = "\u05D4\u05E7\u05D9\u05E9\u05D5\u05E8 \u05D1\u05D5\u05D8\u05DC";
    body = "\u05D0\u05E4\u05E9\u05E8 \u05DC\u05E4\u05E0\u05D5\u05EA \u05DC\u05E2\u05E1\u05E7 \u05DC\u05E7\u05D1\u05DC\u05EA \u05E7\u05D9\u05E9\u05D5\u05E8 \u05D7\u05D3\u05E9.";
  } else {
    head = "\u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05D4\u05EA\u05E7\u05D1\u05DC";
    body = "\u05D4\u05E2\u05E1\u05E7 \u05D9\u05D9\u05E6\u05D5\u05E8 \u05D0\u05D9\u05EA\u05DA \u05E7\u05E9\u05E8 \u05D0\u05DD \u05D9\u05D9\u05D3\u05E8\u05E9 \u05DE\u05E9\u05D4\u05D5 \u05E0\u05D5\u05E1\u05E3.";
  }
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>${esc(head)}</title>
<style>body{margin:0;font-family:Assistant,Arial,sans-serif;background:#f7f3ea;color:#2b2a26;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border-radius:20px;padding:34px 28px;max-width:440px;width:100%;text-align:center;box-shadow:0 12px 30px rgba(120,90,40,.12);border-top:5px solid #a8783f}
h1{font-size:26px;margin:0 0 10px;color:#6e4d22}p{font-size:18px;line-height:1.7;margin:0}.b{margin-top:18px;color:#8a8170;font-size:15px}</style></head>
<body><div class="c"><h1>${esc(head)}</h1><p>${body}</p>${pay ? `<p class="b">${biz}${pay.total ? " \xB7 " + money(pay.total) : ""}</p>` : ""}</div></body></html>`;
}

// netlify/lib/receipt-pdf.mjs
import { PDFDocument, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// netlify/lib/fonts.mjs
var heb = "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AHIAaQBnAGgAdAAgADIAMAAyADAAIABUAGgAZQAgAEEAcwBzAGkAcwB0AGEAbgB0ACAAUAByAG8AagBlAGMAdAAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AaABhAGYAbwBuAHQAaQBhAC8AQQBzAHMAaQBzAHQAYQBuAHQAKQAuACAAQwBvAHAAeQByAGkAZwBoAHQAIAAyADAAMQAwACAAVABoAGUAIABTAG8AdQByAGMAZQAgAFMAYQBuAHMAIABQAHIAbwAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AYQBkAG8AYgBlAC0AZgBvAG4AdABzAC8AcwBvAHUAcgBjAGUALQBzAGEAbgBzAC0AcAByAG8AKQAsACAAdwBpAHQAaAAgAFIAZQBzAGUAcgB2AGUAZAAgAEYAbwBuAHQAIABOAGEAbQBlACAAJwBTAG8AdQByAGMAZQAnAC4AIABTAG8AdQByAGMAZQAgAGkAcwAgAGEAIAB0AHIAYQBkAGUAbQBhAHIAawAgAG8AZgAgAEEAZABvAGIAZQAgAFMAeQBzAHQAZQBtAHMAIABJAG4AYwBvAHIAcABvAHIAYQB0AGUAZAAgAGkAbgAgAHQAaABlACAAVQBuAGkAdABlAGQAIABTAHQAYQB0AGUAcwAgAGEAbgBkAC8AbwByACAAbwB0AGgAZQByACAAYwBvAHUAbgB0AHIAaQBlAHMALgAAAAIAAAAAAAD/nAAyAAAAAAAAAAAAAAAAAAAAAAAAAAAAXwAAACQAyQECAQMBBAEFAQYBBwEIAQkBCgELAQwBDQEOAQ8BEAERARIBEwEUARUBFgEXARgBGQEaARsBHAEdAR4BHwEgASEBIgEjASQBJQEmAScBKAEpASoBKwEsAS0BLgEvATABMQEyATMBNAE1ATYBNwE4ATkBOgAQATsBPAE9AT4BPwFAAAMBQQFCAUMBRAFFAUYBRwFIAUkBSgFLAUwBTQFOAU8BUAFRAVIBUwFUAVUBVgFXAVgBWQFaAVsGQWJyZXZlB3VuaTA1RDAHdW5pMDVEMQd1bmkwNUQyB3VuaTA1RDMHdW5pMDVENAd1bmkwNUQ1B3VuaTA1RDYHdW5pMDVENwd1bmkwNUQ4B3VuaTA1RDkHdW5pMDVEQQd1bmkwNURCB3VuaTA1REMHdW5pMDVERAd1bmkwNURFB3VuaTA1REYHdW5pMDVFMAd1bmkwNUUxB3VuaTA1RTIHdW5pMDVFMwd1bmkwNUU0B3VuaTA1RTUHdW5pMDVFNgd1bmkwNUU3B3VuaTA1RTgHdW5pMDVFOQd1bmkwNUVBB3VuaUZCMkEHdW5pRkIyQgd1bmlGQjJDB3VuaUZCMkQHdW5pRkIyRQd1bmlGQjJGB3VuaUZCMzAHdW5pRkIzMQd1bmlGQjMyB3VuaUZCMzMHdW5pRkIzNAd1bmlGQjM1B3VuaUZCMzYHdW5pRkIzOAd1bmlGQjM5B3VuaUZCM0EHdW5pRkIzQgd1bmlGQjNDB3VuaUZCM0UHdW5pRkI0MAd1bmlGQjQxB3VuaUZCNDMHdW5pRkI0NAd1bmlGQjQ2B3VuaUZCNDcHdW5pRkI0OAd1bmlGQjQ5B3VuaUZCNEEHdW5pRkI0Qgd1bmkyMDEwB3VuaTA1QzAHdW5pMDVDMwd1bmkwNUYzB3VuaTA1RjQHdW5pMDVCRQd1bmkwMEEwB3VuaTIwMEUHdW5pMjAwRgluZXdzaGVxZWwHdW5pMjVjYwd1bmkwMzA4B3VuaTAzMDcNYWN1dGVjb21iLmNhcAt1bmkwMzA2LmNhcAd1bmkwNUIwB3VuaTA1QjEHdW5pMDVCMgd1bmkwNUIzB3VuaTA1QjQHdW5pMDVCNQd1bmkwNUI2B3VuaTA1QjcHdW5pMDVCOAd1bmkwNUI5B3VuaTA1QkEHdW5pMDVCQgd1bmkwNUJDB3VuaTA1QkYHdW5pMDVDMQd1bmkwNUMyB3VuaTA1QzcCQ1IAAAABAAH//wAPAAEAAgAOAAAAAAAAACQAAgADAAEAOwABAEkASgADAE0AXQADAAEAAQAAAAgAAQACAEkASgABAAAACgBMAH4AA0RGTFQANGhlYnIAJGxhdG4AFAAEAAAAAP//AAMAAQACAAMABAAAAAD//wADAAAAAgADAAQAAAAA//8AAgACAAMABGtlcm4ALGtlcm4AJm1hcmsAIG1rbWsAGgAAAAEAAwAAAAEAAgAAAAEAAAAAAAEAAQAEBmwF9gA+AAoABgAQAAEACgAAAAEAIgAiAAEAGAAMAAIABgAGAAEAAAKzAAIAAAW0AAAFtAABAAIASQBKAAQAAAABAAgAAQWgBPQABgT+AAwAOAAABOIE3ATWBNAAAAAABMoExAS+BLgAAAAABLIErASmBKAAAAAABJoElASOBIgAAAAABIIElAR8BHYAAAAABHAEagRkBF4AAAAABFgEUgRMBEYAAAAABEAElAQ6BDQAAAAABC4EKAQiBBwAAAAABHAElAQWBF4AAAAABBAElAQKBAQAAAAAA/4EUgP4A/IAAAAAA+wD5gPgA9oAAAAAA9QElAPOA8gAAAAAA8IExAO8A7YAAAAABHAElAOwBF4AAAAAA6oElAOkA54AAAAABOIDmAOSA4wAAAAAA4YDgAN6A3QAAAAAA24ElANoA2IAAAAAA1wDVgNQA0oAAAAAA0QElAM+AzgAAAAAAzIDmAMsBAQAAAAAAyYExAMgA0oAAAAAAxoEUgMUA/IAAAAAAw4EKAMIAwIC/AAAAvYC8ALqAuQAAAAAAw4EKAMIAwIC/AAAAw4EKAMIAwIC/AAAAw4EKAMIAwIC/AAAAw4EKAMIAwIC/AAABOIE3ATWBNAAAAAABOIE3ATWBNAAAAAABOIE3ATWBNAAAAAABMoExAS+BLgAAAAABLIErASmBKAAAAAABJoElASOBIgAAAAABIIElAR8BHYAAAAAAt4C2ALSAswAAAAAAsYCwAK6ArQAAAAABC4EKAQiBBwAAAAAAq4E3AKoAqIAAAAABBAElAQKBAQAAAAAA/4EUgP4A/IAAAAAA+wD5gPgA9oAAAAAA8IExAO8A7YAAAAAA6oElAOkA54AAAAABOIDmAOSA4wAAAAAA24ElANoA2IAAAAAA1wDVgNQA0oAAAAAAzIDmAMsBAQAAAAAAyYExAMgA0oAAAAAAxoEUgMUA/IAAAAAAw4EKAMIAwIC/AAAAvYC8ALqAuQAAAAABHAEagRkBF4AAAABAIEB9AABABUBVgABAIEAAAABALYB9AABADMA+gABAAwB9AABAK8AAAABAH8B9AABAAwA+gABAGoB9AABAH8AAAABASoB9AABAUkA+gABAFkB9AABAUYAAAABAhUB9AABAUAB9AABAXQA6AABAUAAAAABAKAA+gABAWUAAAABARIBAAABASsAAAABAJQAiwABAPwAAAABAOkB9AABAOkA+gABAOkAAAABARYB9AABAR8A9wABABcB9AABARYAAAABARIB9AABASAA+gABASAArwABAQgB9AABATIBGAABABAB9AABAQgAAAABARsB9AABARwA/QABAA4B9AABALgB9AABAGYA+gABAKMAAAABAHAA+gABATEB9AABAUoA+gABATcAAAABASIB9AABASIA+gABASIAAAABAPMB9AABAIMA+gAB/9sB9AABAMoAAAABAOcB9AABAK0A8wABANIAAAABAPwB9AABALgA+gABALYA9wABAAQBVgABARQB9AABAR4BAAABAEsB9AABARQAAAABARoB9AABAQwA+gABAQwAAAABALMB9AABADEA+gABAAkB9AABAKwAAAABAHAB9AAB//0A+gABAFsB9AABAHAAAAABAREB9AABAQsA+gABAREAAAABAQ0B9AABAK8A+gABABQB9AABAVMAAAABALoB9AABAF4BAAABABwB9AABAM8AAAABARMB9AABALcA+gABABUB9AABANsAAAABARUB9AABAPoASAABACQB9AABARsAAAACAAEABAA7AAAAEwAAAJwAAACcAAEAlgABAJAAAQCKAAEAhAABAJYAAQB+AAEAfgABAHgAAQB4AAIAcgACAGwAAQBmAAMAYAAEAFoABQBUAAIAVAABAE4AAQBR//YAAQBAAZAAAQB+AYIAAQBAAPMAAQBU/+oAAQBAAa4AAQBAAYgAAQBx//YAAQB2//YAAQCc//YAAQCi//YAAQCo//YAAQBA//YAAQAAAfoAAgACAEkASgAAAE0AXQACAAIACAABAAgAAQAWAAUAAAAGAGAAUgBEADwANAAmAAEABgAEAAYAFAAWABwAHgACAA3/8//zAB3/8v/yAAEABf/i/+IAAQAd//L/8gACAAz/8v/yABX/4v/iAAIAB//3//cACv/3//cAAgAQ/+L/4gAd/+L/4gACAAgAAQAIAAIAHAAEAAAAOAAoAAIAAwAA//kAAAAAAAAAAAABAAQAAQACAAMAPAACAAIAAQADAAEAPAA8AAIAAQA8AAEAAQAAAAEAAAAKACwALAADREZMVAAYaGVicgAUbGF0bgAUAAAAAAAEAAAAAP//AAAAAAAAAAEAAQAIAAEAAAAUAAIAAAAcAAJ3Z2h0AQAAAAAEABgAAgAAAAIBAwGQAAABXgAAAfQAAAADAAAAAgEDAZAAAAK8AAA=";
var hebB = "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AGgAZQAgAEEAcwBzAGkAcwB0AGEAbgB0ACAAUAByAG8AagBlAGMAdAAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AaABhAGYAbwBuAHQAaQBhAC8AQQBzAHMAaQBzAHQAYQBuAHQAKQAuACAAQwBvAHAAeQByAGkAZwBoAHQAIAAyADAAMQAwACAAVABoAGUAIABTAG8AdQByAGMAZQAgAFMAYQBuAHMAIABQAHIAbwAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AYQBkAG8AYgBlAC0AZgBvAG4AdABzAC8AcwBvAHUAcgBjAGUALQBzAGEAbgBzAC0AcAByAG8AKQAsACAAdwBpAHQAaAAgAFIAZQBzAGUAcgB2AGUAZAAgAEYAbwBuAHQAIABOAGEAbQBlACAAJwBTAG8AdQByAGMAZQAnAC4AIABTAG8AdQByAGMAZQAgAGkAcwAgAGEAIAB0AHIAYQBkAGUAbQBhAHIAawAgAG8AZgAgAEEAZABvAGIAZQAgAFMAeQBzAHQAZQBtAHMAIABJAG4AYwBvAHIAcABvAHIAYQB0AGUAZAAgAGkAbgAgAHQAaABlACAAVQBuAGkAdABlAGQAIABTAHQAYQB0AGUAcwAgAGEAbgBkAC8AbwByACAAbwB0AGgAZQByACAAYwBvAHUAbgB0AHIAaQBlAHMALgAAAAIAAAAAAAD/nAAyAAAAAAAAAAAAAAAAAAAAAAAAAAAAXwAAACQAyQECAQMBBAEFAQYBBwEIAQkBCgELAQwBDQEOAQ8BEAERARIBEwEUARUBFgEXARgBGQEaARsBHAEdAR4BHwEgASEBIgEjASQBJQEmAScBKAEpASoBKwEsAS0BLgEvATABMQEyATMBNAE1ATYBNwE4ATkBOgAQATsBPAE9AT4BPwFAAAMBQQFCAUMBRAFFAUYBRwFIAUkBSgFLAUwBTQFOAU8BUAFRAVIBUwFUAVUBVgFXAVgBWQFaAVsGQWJyZXZlB3VuaTA1RDAHdW5pMDVEMQd1bmkwNUQyB3VuaTA1RDMHdW5pMDVENAd1bmkwNUQ1B3VuaTA1RDYHdW5pMDVENwd1bmkwNUQ4B3VuaTA1RDkHdW5pMDVEQQd1bmkwNURCB3VuaTA1REMHdW5pMDVERAd1bmkwNURFB3VuaTA1REYHdW5pMDVFMAd1bmkwNUUxB3VuaTA1RTIHdW5pMDVFMwd1bmkwNUU0B3VuaTA1RTUHdW5pMDVFNgd1bmkwNUU3B3VuaTA1RTgHdW5pMDVFOQd1bmkwNUVBB3VuaUZCMkEHdW5pRkIyQgd1bmlGQjJDB3VuaUZCMkQHdW5pRkIyRQd1bmlGQjJGB3VuaUZCMzAHdW5pRkIzMQd1bmlGQjMyB3VuaUZCMzMHdW5pRkIzNAd1bmlGQjM1B3VuaUZCMzYHdW5pRkIzOAd1bmlGQjM5B3VuaUZCM0EHdW5pRkIzQgd1bmlGQjNDB3VuaUZCM0UHdW5pRkI0MAd1bmlGQjQxB3VuaUZCNDMHdW5pRkI0NAd1bmlGQjQ2B3VuaUZCNDcHdW5pRkI0OAd1bmlGQjQ5B3VuaUZCNEEHdW5pRkI0Qgd1bmkyMDEwB3VuaTA1QzAHdW5pMDVDMwd1bmkwNUYzB3VuaTA1RjQHdW5pMDVCRQd1bmkwMEEwB3VuaTIwMEUHdW5pMjAwRgluZXdzaGVxZWwHdW5pMjVjYwd1bmkwMzA4B3VuaTAzMDcNYWN1dGVjb21iLmNhcAt1bmkwMzA2LmNhcAd1bmkwNUIwB3VuaTA1QjEHdW5pMDVCMgd1bmkwNUIzB3VuaTA1QjQHdW5pMDVCNQd1bmkwNUI2B3VuaTA1QjcHdW5pMDVCOAd1bmkwNUI5B3VuaTA1QkEHdW5pMDVCQgd1bmkwNUJDB3VuaTA1QkYHdW5pMDVDMQd1bmkwNUMyB3VuaTA1QzcCQ1IAAAABAAH//wAPAAEAAgAOAAAAAAAAACQAAgADAAEAOwABAEkASgADAE0AXQADAAEAAQAAAAgAAQACAEkASgABAAAACgBMAH4AA0RGTFQANGhlYnIAJGxhdG4AFAAEAAAAAP//AAMAAQACAAMABAAAAAD//wADAAAAAgADAAQAAAAA//8AAgACAAMABGtlcm4ALGtlcm4AJm1hcmsAIG1rbWsAGgAAAAEAAwAAAAEAAgAAAAEAAAAAAAEAAQAEBoQGDgA+AAoABgAQAAEACgAAAAEAIgAiAAEAGAAMAAIABgAGAAEAAALMAAIAAAXMAAAFzAABAAIASQBKAAQAAAABAAgAAQW4BQwABgUWAAwAOAAABPoE9ATuBOgAAAAABOIE3ATWBNAAAAAABMoExAS+BLgAAAAABLIErASmBKAAAAAABJoErASUBI4AAAAABIgEggR8BHYAAAAABHAEagRkBF4AAAAABFgErARSBEwAAAAABEYEQAQ6BDQAAAAABIgErAQuBHYAAAAABCgErAQiBBwAAAAABBYEEAQKBAQAAAAAA/4D+APyA+wAAAAAA+YErAPgA9oAAAAAA9QDzgPIA8IAAAAABIgErAO8BHYAAAAAA7YErAOwBF4AAAAAA6oDpAOeA5gAAAAAA5IDjAOGA4AAAAAAA3oErAN0A24AAAAAA2gDpANiA1wAAAAAA1YErANQA0oAAAAAA0QDpAM+AzgAAAAAAzIE3AMsAyYAAAAAAyAEEAMaAxQAAAAAA9QDDgMIAwIC/AAAAvYC8ALqBOgAAAAAA9QDDgMIAwIC/AAAA9QDDgMIAwIC/AAAA9QDDgMIAwIC/AAAA9QDDgMIAwIC/AAABPoE9ATuBOgAAAAABPoE9ATuBOgAAAAABPoE9ATuBOgAAAAABOIE3ATWBNAAAAAABMoExAS+BLgAAAAABLIErASmBKAAAAAABJoErASUBI4AAAAAAuQC3gLYAtIAAAAAAswCxgLAAroAAAAABEYEQAQ6BDQAAAAAArQCrgKoAqIAAAAABCgErAQiBBwAAAAABBYEEAQKBAQAAAAAA/4D+APyA+wAAAAAA9QDzgPIA8IAAAAAA7YErAOwBF4AAAAAA6oDpAOeA5gAAAAAA3oErAN0A24AAAAAA2gDpANiA1wAAAAAA0QDpAM+AzgAAAAAAzIE3AMsAyYAAAAAAyAEEAMaAxQAAAAAA9QDDgMIAwIC/AAAAvYC8ALqBOgAAAAABIgEggR8BHYAAAABAKsB9AABACIBWgABAD0B9AABAKsAAAABAMYB9AABACUA+gABAA8B9AABAMQAAAABAKYB9AABAB0A+gABAJMB9AABAKYAAAABAVcA+gABAFYB9AABAVAAAAABAjYB9AABAVcB9AABAXkAzQABAGAB9AABAPMB9AABAJkA+gABAWMAAAABASkB9AABAR8BCQABAV0AAAABARAB9AABAIQAqAABARAAAAABAQsB9AABAQsA+gABAQsAAAABARgB9AABAScA8wABARgAAAABARoB9AABAR8A+gABAR8APwABASAB9AABAT4BRQABABMB9AABASAAAAABATEB9AABATQBAgABABUB9AABATEAAAABAFsA+gABALcAAAABAIIA+gABAUgB9AABAVkA+gABABgB9AABAVcAAAABASgB9AABASgA+gABASgAAAABAP0B9AABAHsA+gAB/84B9AABAOIAAAABAPEB9AABAJwA+AABABAB9AABAOoAAAABAQEB9AABAKIA+gABAJwA8wAB//kBWgABAS4B9AABATgBCQABAGEB9AABAS4AAAABASoB9AABASUA+gABASUAAAABAL8B9AABAB4A+gABAAkB9AABAL0AAAABAIIB9AAB//gA+gABAG4B9AABAIIAAAABAR8B9AABARwA+gABAR8AAAABARIB9AABAJAA+gABABQB9AABAUQAAAABANEB9AABAGMBCQABAC4B9AABANkAAAABARQB9AABAKYA+gABABYB9AABAQAAAAABAToB9AABARoALQABACMB9AABAT0AAAACAAEABAA7AAAAEwAAAJwAAACcAAEAlgABAJAAAQCKAAEAhAABAJYAAQB+AAEAfgABAHgAAQB4AAIAcgACAGwAAQBmAAMAYAAEAFoABQBUAAIAVAABAE4AAQBR//IAAQBAAZAAAQB+AYIAAQBAAPMAAQB2/+4AAQBAAdsAAQBAAXsAAQBx//IAAQB2//IAAQCg//IAAQCi//IAAQCo//IAAQBA//IAAQAAAgMAAgACAEkASgAAAE0AXQACAAIACAABAAgAAQAWAAUAAAAGAGAAUgBEADwANAAmAAEABgAEAAYAFAAWABwAHgACAA3/7//vAB3/+//7AAEABf/i/+IAAQAd//v/+wACAAz/+//7ABX/4v/iAAIAB//q/+oACv/q/+oAAgAQ/+L/4gAd/+L/4gACAAgAAQAIAAIAHAAEAAAAOAAoAAIAAwAA//4AAAAAAAAAAAABAAQAAQACAAMAPAACAAIAAQADAAEAPAA8AAIAAQA8AAEAAQAAAAEAAAAKACwALAADREZMVAAYaGVicgAUbGF0bgAUAAAAAAAEAAAAAP//AAAAAAAAAAEAAQAIAAEAAAAUAAEAAAAcAAJ3Z2h0AQAAAAACAAIAAAAAAQUCvAAAAooAAALuAAAAAA==";
var lat = "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AGcAdQBsAGEAcgBBAHMAcwBpAHMAdABhAG4AdABDAG8AcAB5AHIAaQBnAGgAdAAgADIAMAAyADAAIABUAGgAZQAgAEEAcwBzAGkAcwB0AGEAbgB0ACAAUAByAG8AagBlAGMAdAAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AaABhAGYAbwBuAHQAaQBhAC8AQQBzAHMAaQBzAHQAYQBuAHQAKQAuACAAQwBvAHAAeQByAGkAZwBoAHQAIAAyADAAMQAwACAAVABoAGUAIABTAG8AdQByAGMAZQAgAFMAYQBuAHMAIABQAHIAbwAgAEEAdQB0AGgAbwByAHMAIAAoAGgAdAB0AHAAcwA6AC8ALwBnAGkAdABoAHUAYgAuAGMAbwBtAC8AYQBkAG8AYgBlAC0AZgBvAG4AdABzAC8AcwBvAHUAcgBjAGUALQBzAGEAbgBzAC0AcAByAG8AKQAsACAAdwBpAHQAaAAgAFIAZQBzAGUAcgB2AGUAZAAgAEYAbwBuAHQAIABOAGEAbQBlACAAJwBTAG8AdQByAGMAZQAnAC4AIABTAG8AdQByAGMAZQAgAGkAcwAgAGEAIAB0AHIAYQBkAGUAbQBhAHIAawAgAG8AZgAgAEEAZABvAGIAZQAgAFMAeQBzAHQAZQBtAHMAIABJAG4AYwBvAHIAcABvAHIAYQB0AGUAZAAgAGkAbgAgAHQAaABlACAAVQBuAGkAdABlAGQAIABTAHQAYQB0AGUAcwAgAGEAbgBkAC8AbwByACAAbwB0AGgAZQByACAAYwBvAHUAbgB0AHIAaQBlAHMALgAAAAIAAAAAAAD/nAAyAAAAAAAAAAAAAAAAAAAAAAAAAAAA7wAAACQAyQECAMcAYgCtAGMArgCQACUAJgBkACcA6QAoAGUAyADKAMsAKQAqACsALADMAM0AzgDPAC0ALgAvADAAMQBmADIA0ADRAGcA0wCRAK8AsAAzAO0ANAA1ADYANwA4ANQA1QBoANYAOQA6ADsAPADrAD0ARABpAGsAbABqAG4AbQCgAEUARgBvAEcA6gBIAHAAcgBzAHEASQBKAEsATADXAHQAdgB3AHUATQBOAE8AUABRAHgAUgB5AHsAfAB6AKEAfQCxAFMA7gBUAFUAVgCJAFcAWAB+AIAAgQB/AFkAWgBbAFwA7AC6AF0AwADBAJ0AngEDAQQAEwAUABUAFgAXABgAGQAaABsAHAC8APQA9QD2AA0APwDDAIcAHQAPAKsABACjAAYAEQAiAKIABQAKAB4AEgBCAF4AYAA+AEAACwAMALMAsgAQAQUAqQCqAL4AvwDFALQAtQC2ALcAxAADAQYAhAC9AAcBBwCFAJYAYQC4AQgAIAAhAB8ApADvAPAACAAOAJMAXwDoACMACQCIAIsAigCGAIwAgwBBAQkBCgELAQwBDQEOAQ8BEAERARIBEwEUARUBFgEXARgBGQEaAI0A3gDYAI4AQwDaAN0A2QDxAPIA8wEbAJcGQWJyZXZlBmEuc3VwcwZvLnN1cHMHdW5pMDBBRAd1bmkwMEEwBEV1cm8HdW5pMjIxNQd1bmkwMzA4B3VuaTAzMDcJZ3JhdmVjb21iCWFjdXRlY29tYgd1bmkwMzAyB3VuaTAzMEEJdGlsZGVjb21iB3VuaTAzMDQMZG90YmVsb3djb21iB3VuaTAzMjcLdW5pMDMwOC5jYXANZ3JhdmVjb21iLmNhcA1hY3V0ZWNvbWIuY2FwC3VuaTAzMDIuY2FwC3VuaTAzMDYuY2FwC3VuaTAzMEEuY2FwDXRpbGRlY29tYi5jYXALdW5pMDMyNy5jYXACQ1IAAAABAAH//wAPAAEAAgAOAAAAAAAAADwAAgAHAAEAKgABACwAaAABAGoAdgABAHcAeAACANAA0AADANIA0wADANYA2AADAAEAAQAAAAgAAQAFANAA0gDTANYA1wAAAAEAAAAKAE4AigADREZMVAA0aGVicgAkbGF0bgAUAAQAAAAA//8AAwACAAMABAAEAAAAAP//AAMAAQADAAQABAAAAAD//wADAAAAAwAEAAVrZXJuADZrZXJuADZrZXJuAC5tYXJrACZta21rACAAAAABAAQAAAACAAIAAwAAAAIAAAABAAAAAQAAAAUccgToAJ4AWAAMAAYAEAABAAoAAAABADQANAABAB4ADAAFAAwEsASwBLAEsAABAAACswAFAAAEngAABJ4AAASeAAAEngAABJ4AAQAFANAA0gDTANYA1wAFAAAAAQAIAAEAOAAqAAEAMgAMAAIAEgAGAAIDIgAGAAEBrf/sAAIDFgAGAAEBlf/sAAEAAgB3AHgAAQAABDoAAQABANgABAAAAAEACAABBDID8AACBAwADABzAAAD3gAAA94AAAPeAAAD3gAAA94AAAPeAAAD3gAAA94AAAPYAAAD0gAAA8wAAAPMAAADxgAAA8AAAAO6AAADugAAA7oAAAO6AAADugAAA7QAAAOuAAADqAAAA6IAAAOiAAADogAAA6IAAAOiAAADnAAAA5YAAAOQAAADigAAA4QAAAOEAAADfgAAA34AAAN+AAADfgAAA34AAAN4AAADfgAAA3IAAANsAAADZgAAA2AAAANaAAADWgAAA1oAAANaAAADWgAAA1QAAANOAAADSAAAA0IAAANCAAADPAM2AzADNgMwAyoDMAMkAzADNgMwAzYDMAM2AzADHgMYAAADEgMMA2ADDANgAAADBgAAAwAC+gL0AvoC9ALuAvQC6AL0AvoC9AAAAuIC3ALWAAAC0ALKAsQCvgLEAr4CxAK4AsQCsgLEAr4CxAKsAqYAAAPeAAACoAKaApQCjgKIAo4CiAKCAnwCggJ8AnYCfAJwAnwCggJ8AoICfAKCAnwCagMYAmQCXgJYAzwCUgJMAkYCxAJAAjoCNAIuAigCIgIoAiICHAIiAhYCIgIoAiICEAIKAgQB/gH4AfIB7AHmAewB5gHgAeYB2gHUAc4AAAABAZYB+gABAOH/7AABAOUB+gABAPECswABAMv/IwABAPEB+gABANr/7AABANoB+gABAWP/7AABAWMB+gABAOf/7AABAOcB+gABARECswABAREC3AABARv/7AABAREB+gABAM3/7AABAIwCfwABANz/7AABANsB+gABANEB+gABAa7/IwABARcB+gABAKcC2gABAHf/IwABASAB+gABAboB+gABAQ4CswABAQ4C3AABAQ7/7AABAQ4B+gABARb/7AABASMB+gABAab/7AABAaIB+gABAJH/7AABAHn/DQABAHsCxQABAHoCswABAHoC3AABAHoB+gABAHj/7AABAHkB+gABAR7/7AABAQP/IwABAQIB+gABAIX/7AABAQoCswABAQoC3AABAQD/7AABAQoB+gABAQ//7AABASb/7AABARAB+gABARj/7AABAaX/7AABAZ0B+gABAQ0CswABAQ0C3AABAPf/7AABAQ0B+gABARr/7AABAOz/7AABAPj/7AABAYr/7AABAP//7AABAUH/7AABAQv/7AABARD/7AABATP/7AABAIb/7AABAU3/7AABAUv/7AABAUX/7AABAWr/7AABASH/7AABAUf/7AABAPv/7AABAIH/7AABAUP/7AABAVr/7AABAIT/7AABASL/7AABAT3/7AABAS//7AABAVb/7AABASz/7AABAaP/7AABAQz/7AACAAQAAQAoAAAAKgAqACgALQBoACkAagB3AGUABgAAACAAAAAgAAAAIAAAACAAAAAgAAEAGgABAAD/7AABAAAB+gABAAYA0ADSANMA1gDXANgAAgAIAAIReAAKAAIOUAAEAAAQCA6uADAAJgAAAAAAAAAA//YAAAAAAAAAAAAA/+wAAAAAAAAAAP/6/+n/7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2v/2//n/8AAAAAAAAAAA//MAAAAAAAD/8gAAAAAAAAAA//YAAAAAAAcAAP/9//7/+//H/9MAAP/+//AAAAAAAAAAAP/h//H/5wAAAAD/7QAA//0AAP/3//3//f/wAAAAAAAA//IAAAAAAAAAAAAA/+wAAAAKAAAABwAAAAH/6f/nAAD//v/2AAAAAAABAAAAAAAA//YAAP/s//H/9gAAAAD/+gAHAAf/+gAA//YAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//YAAAAAAAAAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9gAA/+MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/s/+IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8wAAAAAAAAAAAAAAAAAAAAAAAP/2ABj/+f/5AAD/8AAAAAD/+AAAAAD/+gAYAAD/zP/zAAD/9v/zAAAAAAAAAAD/zP+//8gAAAAA//MAAAAFAAD/5//6//3//QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+n/6QAAAAD/8wAAAAAAAAAAAAAAAP/xAAAAAP/x//0AAAAA//cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/p//EAAAAAAAAAAAAAAAAAAAAAAAD/7AAAAAD/9gAAAAAAAP/6AAAAAAAAAAAAAAAA//3/7wAAAAAAAP/x//YAAAAA//YAAP/9AAAAAP/zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/S//0AAP/2AAAAAAAAAAD/+gAA//UAAAAAAAAAAAAA/+0AAAAAAAAAAAAA/+wAAAAA/53/pwAAAAD/1QAAABkAAAAAAAAAAAAAAAAAAP/B/98AAAAAAAD/4f/sAAAAAAAAAAAAAP/9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/8//9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//MAAAANAAAAAAAAAAL/7P/zAAAAAP/pAAAAAAAAAAAAAAAA//cAAP/zAAAAAAAAAAAAAAAAAAAAAAAA/+n/7P/v//n/6AAA//YAAP/i/+//3f/y/+8AAAAAAAD/8wAA/+z/8wAAAAD/3QAAAAAAAAAAAAD/3v/5//kAAAAAAAD/7//v/+kAAAAAAAAAAAAAAAAAAAAAAAD/8P/sAAAAAAAAAAAAAP/S/78AAAAA/+UAAAAAAAAAAAAAAAAAAAAA/+z/7f/2/+YAAAAA//oAAP/zAAD/8wAA//AAAAAAAAAAAAAAAAAAAAAAAAAAEQAA//P/5//zAA8AAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/3f/9//0AAAAA//0AAP/sAAAAAAAAAAD/4QAAAAAAAAAAAAAAAP/p/+z/+gAAAAAAAAAA//b//f/9AAAAAAAAAAD/2P/9AAD//QAAAAAAAAAA//MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAAAAAAAAAP/p/+wAAAAA//YAAAAAAAAAAAAAAAD/9wAAAAD/9gAAAAAAAP/3AAAAAAAAAAD/9gAA/+gAAP/2AAAAAAAAAAAAAP/x//n//QAAAAD/5f/hAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9AAAAAAAAAAD/5QAAAAD/9gAA//MAAP/p//b/5//s//MAAAAA/+7/+gAAAAD/5gAAAAD/8wAAAAAAAAAAAAD/9v/9//3//QAAAAD/8//2AAAAAP/6/+0AAP/2//IAAP/zAAD/+QAA/+YAAP/uAAD/8//w//EAAAAA/+EAAP/2//b//f/t//L/8gAAAAD/9P/2AAAAAP/6/+7/8f/xAAD/v//p/7b/2P/R/9EAAP+X/9f/yf+2/7b/3v/F/7MAAP/zAAD/7v/u/+wAAP/S/9gAAAAAAAD/qP+BAAAAAP/sAAAAAP/e/93/1wAA/9n/8/++//P/3//Y//b/qP/w/+X/v//E//P/2f/S//MAAAAAAAD/5//pAAD/zP/dAAAAAAALAAD/nAAAAAAAAAAA//r/8//p/98AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAAAAAAAAAAAAAA/+wAAAAAAAAAAAAAAAAAAAAAAAD/7AAA//YAAAAAAAAAAAAAAAAAAP/u//YABwAAAAD/7P/pAAAAAP/2AAAAAP/zAAAAAAAAAAAAAAAA//MAAAAAAAAAAAAHAAcACgAA/+8AAP/2AAD/8wAAAAAADgAAAAD/2v/2AAAAAP/6/+D/9gAAAAD/7QAO//b/5//3AAAAAP/nAAAAAAAAAAAAAAAA//cAAAAA//oAAP/zAAD/6wAAAAAAAAAAAAkAAAAA/+f/9gAA//0AAP/z//0AAAAA/+wADwAA/+7/8wAAAAAAAAAAAAAAAAAAAAAAAP/nAAAAAP/vAAAAAAAAAAAAAAAAAAAAAAAA//P//QAAAAD/8wAAAAD/6f/zAAAAAP/2AAAAAAAAAAAAAP/z/+wAAP/w//v//f/9AAAAAP/z//b/9gAA//X/5wAAAAT/9gAA/+UAAP/qAAD/yf/9/98AAAAA/4j/tQAA//P/7QAAAAD/3QAA/67/tv+2AAAAAP+0/8gAAAAA/+P/3//fAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+cAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0AAAAA/9j/3QAAAAD/8wAAAAAAAAAAAAAAAAAAAAAAAP/w//D/8wAAAAD//QAA/+wAAAAAAAAAAAAAAAAAAAAAAAD/4v/uAAAAAP/6AAAAAP/T/8wAAAAA/94AAAAAAAAAAAAAAAAAAAAA/+L/6//2//MAAAAA//oAAP/pAAD/4QAAAAD/zAAAAAAAAAAA//YAAAAAAAAAAP/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP+kAAAAAP/2AAAAAAAAAAAAAAAA/94AAP/U/8gAAAAAAAAAAP/zAAAAAP/eAAD/9gAAAAAACwAA//MAAAAAAAAAAAAAAAAAAAAA/6j/uAAOAA7/+gAAAAAAAAAAAAAAAP/CAAD/vP/JAAD/8gAAAAAAAAAAAAD/0AAA/83/5QAAAAAAAP/vAAAAAAAAAAAAAAAAAAAAAP+o/7IAAAAA//oAAAAAAAAAAAAAAAD/8//2/9//2//w/+wAAP+7/+3/4gAA/+n/8f/t/+YAAAAEAAAAAP/2AAAAAP/sAAAAAAAAAAAAAP91AAUABf/pAAAAAP/u//H/5wAAAAAAAAAAAAAAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2AAAAAAAAAAAAAAAAAAAAAAAAP/oAAD/1P/OAAAAAAAA/5P/9v+u/97/4AAA//b/7P/n//YAAAAAAAAAAAAA/+wAAAAAAAAAAAAA/20AAAAA/+kAAAAAAAAAAP/zAAD/9gAA//3//QAAAAAAAAAA//L/9v/h//0AAAAA//r/8wABAAAAAAAAAAAAAP/i//MAAAAAAAAAAP/uAAgAB//9AAAAAAAAAAD/+gAA//L/9v/s//P/4v/s//b/wf/2/+3/7f/r//f/9P/mAAAAAAAAAAAAAAAAAAD/6//vAAAAAAAOAAD/tgAKAAAAAAAAAAD/9//3//IAAAAA//n/7wAAAAAAAAAA/9//+f/5//b/8gAAAAD/9gAAAAAAAAAAAAAAAAAA//b/8QAAAAAADgAA/7wAAAAAAAAAAAAAAAAAAAAAAAD/+v/w//YABP/2AAD/9gAA//MAAP/mAAD/8QAA//P/7AAAAAD/8f/xAAAAAP/z//P/9v/6//oAAAABAAAAAAAAAAAAAP/x//P/9gAA//YAAP/sAAAAAAAAAAD/0AAAAAD/8//yAAD//f/zAC8APQAzAAAAAAAA//YAAAAAACgAIwAjAAAAAABDAC8AIgAPABsADgAA//0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/xAAAAAAAAAAAAAP/9//AAAAAAAAAAAP++/9P/zQAAAAAAAAAAAAAAAP/x//H/8wAHAAD/9gAA/+n/8wAAAAAAAP/MAAD/9v/p//YAHP/9//0AAAAAAAAAAAAAABwAAP/sAAAAAAAiABYAAP/MAAAAAAAAAAAAAAAcABUAAAAA//0AAP/s//UAAAAAAAD/4QAA//b/+gAAAAAAAP/p/+z/8wAAAAAAAAAA//YAAAAAAAAAAAAAAAD/2P/3AAAAAAAAAAAAAAAAAAAAAP/9AAD/9v/9AAAAAAAA/94AAAAAAAAAAAAAAAD/8P/p/+kAAAAAAAAAAP/2AAAAAAAAAAAAAAAA/+L/9wAA//MAAAAAAAAAAAAAAAD/8P/2//YAAAAAAAAAAP/6//0AAP/zAAAAAQAAAAD/3v/fAAAAAP/pAAAAAP/p/+wAAAAAAAAAAAAA//IAAP/2//MAAAAAAAAAAAACAA8AAQAVAAAAHAAeABUAIgAqABgALABFACEASABPADsAUQBRAEMAVwB2AEQAeAB4AGQAjwCRAGUAlQCVAGgAmACaAGkAnQCdAGwAnwCfAG0AoQChAG4AowCwAG8AAgA5AAEACAAEAAkACQAcAAsADAACABUAFQACABwAHAAdACIAKQACACwALAACAC4ALgAJAC8ALwAQADAANAAHADUANQAeADYANgAfADcANwAgADgAOQARADoAOgAKADsAQgADAEQARgABAEgATAABAE0ATQATAE4ATgAMAFEAUQAGAFYAVgAWAFkAWwAGAFwAYwABAGQAZAAGAGYAZgABAGcAZwAGAGgAaAAOAGoAagAUAGsAbwAFAHAAcAAjAHEAcQAkAHIAcgAlAHMAdQANAHYAdgAPAHcAeAATAI8AjwAVAJAAkQAIAJIAkgAhAJUAlQAIAJYAlgAiAJgAmQAZAJoAmgAVAJ4AngASAKAAoAASAKIAogASAKMApgALAKcApwAXAKgAqAAYAKkAqQAXAKoAqgAYAKsAqwAIAKwArAAaAK0ArQAbAK4ArgAaAK8ArwAbALAAsAAIAAEAAQCwAAUABQAFAAUABQAFAAUABQADABoAEgASAAAAAAADAAMAAwADAAMAIwAKAAAAAAAAAAAAAAAAACQAEwAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAlAAAAAAAmAAsAFAAIAAgACAAIAAgAJwAoACkAFQAVAAwABgAGAAYABgAGAAYABgACAAEAFwAXAAAAAAACAAIAAgACAAIAKgAOAAcAAAAEAAAAAAAAAAAAAAAYAB0ABwAHAAcAAQABAAEAAQABAAEAAQACAAEAAQAEACwAEAArABkABAAEAAQABAAEAC0ALgAvAA8ADwAPABEAAAAdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAJAAkAAAAAAAAACQAAAAAAIAAgABwAAAAAABYAAAAWAAAAFgAAAA0ADQANAA0AHgAfAB4AHwAJACEAIgAhACIACQABAMwABAAAAGEF/AX8BfwF/AX8BfwF/AX8Be4F4AXgBc4FzgW0BaYFlAV+Bc4FzgXOBc4FzgXOBc4FcAVeBc4FUAVCBTAFKgUqBSoFKgUqBQgE+gToBNYE1gTIBMIEwgTCBMIEwgTCBMIErASWBIwEjASsBKwErASsBKwEdgRkBFoERAQyBFoEWgRaBJYElgSWBJYElgSWBJYErASWBJYERAQgBy4EFgQIBEQERAREBEQERAP2A+QDygO4A7gDuAOqA2ADHgMIAhIBJAACAA4AAQAIAAAACgAOAAgAFAAVAA0AHQAeAA8AIgAoABEAKgBFABgASABPADQAUQBRADwAVwBXAD0AWQB2AD4AjACNAFwAkwCTAF4AlwCXAF8AmwCbAGAAOwAB/9gAAv/YAAP/2AAE/9gABf/YAAb/2AAH/9gACP/YAAv/9gAM//YAFf/2ABz/sAAi//YAI//2ACT/9gAl//YAJv/2ACf/9gAo//YAKf/2ACz/9gA7/+kAPP/pAD3/6QA+/+kAP//pAED/6QBB/+kAQv/pAET/3gBF/94ARv/eAEj/3gBJ/94ASv/eAEv/3gBM/94ATv/2AFAAHABSABwAUwBEAFQARABVACgAVgAcAFz/3gBd/94AXv/eAF//3gBg/94AYf/eAGL/3gBj/94AZv/eAGoACwBr/+wAbP/sAG3/7ABu/+wAb//sAD0AAf/GAAL/xgAD/8YABP/GAAX/xgAG/8YAB//GAAj/xgAL/9oADP/aABX/2gAi/9oAI//aACT/2gAl/9oAJv/aACf/2gAo/9oAKf/aACz/2gAu/+EAL/+qADD/2gAx/9oAMv/aADP/2gA0/9oANf/KADb/2gA3/9oAOP+sADn/rAA7/+AAPP/gAD3/4AA+/+AAP//gAED/4ABB/+AAQv/gAET/7QBF/+0ARv/tAEj/7QBJ/+0ASv/tAEv/7QBM/+0ATf/GAFYAPQBc/+0AXf/tAF7/7QBf/+0AYP/tAGH/7QBi/+0AY//tAGb/7QB3/8YAeP/GAAUANf/jADb/8QA4/9cAOf/XAFYAIgAQAAH/6QAC/+kAA//pAAT/6QAF/+kABv/pAAf/6QAI/+kALv/pAC//wQA1/+cAN//nADj/ygA5/8oAOv/aAHL/7AASAA7/4QAv/6gAMP/hADH/4QAy/+EAM//hADT/4QA1/8oANv/hADj/tgA5/7YATgAiAFYASgBw/+wAcf/2AHMADgB0AA4AdQAOAAMAjf/1AMsAHADNAA4ABACLAAAAm//xAMsAMADNAA4ABgCL/+kAjf/sAJAABgCaAAYAywAqAM0ACwAEAIv/9QCb//gAywAqAM0ADAAEAIv/9QCb/+wAywAwAM0ACwADAI3/7ACbAAwAywAjAAIAjP/nAMv/4AAEAIwADgCN/+8Am//dAMsAQgAEAIv/6wCN/+cAywABAM3/7AAFAIv/5wCMAAAAjQAAAJsAAADLAAAAAgCL/90Azf/sAAQAi//eAI3/+ACbADMAywAPAAUAjABCAI3/7ACb//EAywBPAM0ATQACAI3/8wDLABYABQCL/+QAjP/nAI0AAADL//oAzQAAAAUAi//dAIz/7gCN//0AywABAM3/8AABAIv/yQADAI3/xADLABQAzQAUAAQAjf/TAJv/uwDLACIAzQAvAAQAi//2AI3/2ADLAAsAzQAVAAMAm//gAMsAKQDNACEACABSAA4AUwA2AFQAPwBVABQAjf/zAJv/zwDLADUAzQA1AAEAm//eAAQAjf/BAJv/pADLABQAzQAjAAMAi//vAI3/9QDLAAQAAwCL//YAjf/2AMsAHAAEAIv/vwCM/9gAm//CAM3/6QADAI3/+ACb/7EAywAgAAUAi/9rAIz/sACN/6cAy/+nAM3/ogAEAIv/2ACN/9MAywAGAM0ACwADAIv/5ADLAAsAzQAPAAYAUwAfAFQAJQCN//MAm/+4AMsAFgDNACoABACL/90Am//uAMsABwDN/+cAAwCN/88AywAMAM0AGQADAIv/4gCN/+wAzf/sAAUAi/+hAIz/2ACN/+kAy/+yAM3/zwACAAgAAgDaAAoAAgBMAAQAAACiAGgABgAFAAAAAP+l/7L/ngAA/5AAAAAAAAAAAP+zAAAAAAAAAAD/fwAAAAAAAAAAAAAAAAAA/+MAAAAAAAAAAP/tAAIABACQAJIAAACVAJYAAwCYAJkABQCrALAABwACAAkAkACRAAEAlQCVAAEAmACZAAIAqwCrAAEArACsAAMArQCtAAQArgCuAAMArwCvAAQAsACwAAEAAgAHAJIAkgAEAJYAlgAFAJgAmQABAKwArAACAK0ArQADAK4ArgACAK8ArwADAAEAHAAEAAAACQBCADwAPAA8AEIAPAAyADIAPAABAAkAjwCQAJEAlQCaAKsArACuALAAAgCT/8oAl/96AAEAi/96AAEAi//MAAAAAQAAAAoAPABiAANERkxUACRoZWJyACRsYXRuABQABAAAAAD//wADAAAAAQACAAQAAAAA//8AAgABAAIAA2NjbXAAIGZyYWMAGmxpZ2EAFAAAAAEABAAAAAEAAwAAAAEAAAAFAH4AcABwADQADAAEAAAAAQAIAAEAGgABAAgAAgAMAAYAeAACAFgAdwACAFAAAQABAE0ABAAAAAEACAABACwAAgAWAAoAAQAEAIoAAwCbAIEAAgAOAAYAiAADAJsAfwCJAAMAmwCBAAEAAgB+AIAAAQAAAAEACAABAEoAAQAGAAAAAgAkAAoAAwAAAAEAOgACABQALAABAAAAAgABAAEA2AADAAAAAQAgAAEAEgABAAAAAQABAAUA0ADSANMA1gDXAAEAAQBQAAAAAQABAAgAAQAAABQAAgAAABwAAndnaHQBAAAAAAQAGAACAAAAAgEDAZAAAAFeAAAB9AAAAAMAAAACAQMBkAAAArwAAA==";
var latB = "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AG8AbQAvAGgAYQBmAG8AbgB0AGkAYQAvAEEAcwBzAGkAcwB0AGEAbgB0ACkALgAgAEMAbwBwAHkAcgBpAGcAaAB0ACAAMgAwADEAMAAgAFQAaABlACAAUwBvAHUAcgBjAGUAIABTAGEAbgBzACAAUAByAG8AIABBAHUAdABoAG8AcgBzACAAKABoAHQAdABwAHMAOgAvAC8AZwBpAHQAaAB1AGIALgBjAG8AbQAvAGEAZABvAGIAZQAtAGYAbwBuAHQAcwAvAHMAbwB1AHIAYwBlAC0AcwBhAG4AcwAtAHAAcgBvACkALAAgAHcAaQB0AGgAIABSAGUAcwBlAHIAdgBlAGQAIABGAG8AbgB0ACAATgBhAG0AZQAgACcAUwBvAHUAcgBjAGUAJwAuACAAUwBvAHUAcgBjAGUAIABpAHMAIABhACAAdAByAGEAZABlAG0AYQByAGsAIABvAGYAIABBAGQAbwBiAGUAIABTAHkAcwB0AGUAbQBzACAASQBuAGMAbwByAHAAbwByAGEAdABlAGQAIABpAG4AIAB0AGgAZQAgAFUAbgBpAHQAZQBkACAAUwB0AGEAdABlAHMAIABhAG4AZAAvAG8AcgAgAG8AdABoAGUAcgAgAGMAbwB1AG4AdAByAGkAZQBzAC4AAAACAAAAAAAA/5wAMgAAAAAAAAAAAAAAAAAAAAAAAAAAAO8AAAAkAMkBAgDHAGIArQBjAK4AkAAlACYAZAAnAOkAKABlAMgAygDLACkAKgArACwAzADNAM4AzwAtAC4ALwAwADEAZgAyANAA0QBnANMAkQCvALAAMwDtADQANQA2ADcAOADUANUAaADWADkAOgA7ADwA6wA9AEQAaQBrAGwAagBuAG0AoABFAEYAbwBHAOoASABwAHIAcwBxAEkASgBLAEwA1wB0AHYAdwB1AE0ATgBPAFAAUQB4AFIAeQB7AHwAegChAH0AsQBTAO4AVABVAFYAiQBXAFgAfgCAAIEAfwBZAFoAWwBcAOwAugBdAMAAwQCdAJ4BAwEEABMAFAAVABYAFwAYABkAGgAbABwAvAD0APUA9gANAD8AwwCHAB0ADwCrAAQAowAGABEAIgCiAAUACgAeABIAQgBeAGAAPgBAAAsADACzALIAEAEFAKkAqgC+AL8AxQC0ALUAtgC3AMQAAwEGAIQAvQAHAQcAhQCW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";

// netlify/lib/receipt-pdf.mjs
var DOC_LABELS = { 320: "\u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA \u05DE\u05E1 \u05E7\u05D1\u05DC\u05D4", 305: "\u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA \u05DE\u05E1", 400: "\u05E7\u05D1\u05DC\u05D4", 330: "\u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA \u05D6\u05D9\u05DB\u05D5\u05D9", 300: "\u05D7\u05E9\u05D1\u05D5\u05DF \u05E2\u05E1\u05E7\u05D4" };
var DEALERS = { exempt: "\u05E2\u05D5\u05E1\u05E7 \u05E4\u05D8\u05D5\u05E8", licensed: "\u05E2\u05D5\u05E1\u05E7 \u05DE\u05D5\u05E8\u05E9\u05D4", company: "\u05D7\u05D1\u05E8\u05D4 \u05D1\u05E2\u05F4\u05DE" };
var HEB = /[֐-׿יִ-ﭏ]/;
var STRONG_L = /[A-Za-z0-9À-ɏ@_]/;
var DIGIT = /[0-9]/;
var ET = /[%₪$€#°+]/;
var JOIN = /[.,:/\-]/;
var MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
function visual(text) {
  const s = [...String(text ?? "")];
  if (!s.length) return "";
  const t = s.map((c) => HEB.test(c) ? "R" : DIGIT.test(c) ? "EN" : STRONG_L.test(c) ? "L" : "N");
  for (let i = 0; i < s.length; i++) {
    if (t[i] !== "N") continue;
    if (JOIN.test(s[i]) && t[i - 1] === "EN" && t[i + 1] === "EN") t[i] = "EN";
  }
  for (let i = 0; i < s.length; i++) if (t[i] === "N" && ET.test(s[i]) && (t[i - 1] === "EN" || t[i + 1] === "EN")) t[i] = "EN";
  const str = s.join("");
  for (const m of str.matchAll(/[\w.+-]+@[\w.-]+|https?:\/\/\S+|www\.\S+/g)) {
    const a = [...str.slice(0, m.index)].length, n = [...m[0]].length;
    for (let i = a; i < a + n; i++) t[i] = "L";
  }
  const strongBefore = (i) => {
    for (let k = i - 1; k >= 0; k--) if (t[k] === "L" || t[k] === "R") return t[k];
    return "R";
  };
  for (let i = 0; i < s.length; i++) if (t[i] === "EN" && strongBefore(i) === "L") t[i] = "L";
  const asStrong = (x) => x === "EN" ? "R" : x;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    if ("([{".includes(s[i]) && t[i] === "N") stack.push(i);
    else if (")]}".includes(s[i]) && t[i] === "N") {
      const o = stack.pop();
      if (o === void 0) continue;
      const inside = t.slice(o + 1, i).map(asStrong);
      let dir = null;
      if (inside.includes("R")) dir = "R";
      else if (inside.includes("L")) {
        let k = o - 1;
        while (k >= 0 && t[k] === "N") k--;
        dir = k >= 0 && asStrong(t[k]) === "L" ? "L" : "R";
      }
      if (dir) {
        t[o] = dir;
        t[i] = dir;
      }
    }
  }
  const d = t.map((x, i) => {
    if (x !== "N") return x === "EN" ? "EN" : x;
    let p = i - 1;
    while (p >= 0 && t[p] === "N") p--;
    let n = i + 1;
    while (n < t.length && t[n] === "N") n++;
    const a = p >= 0 ? asStrong(t[p]) : "R", b = n < t.length ? asStrong(t[n]) : "R";
    return a === "L" && b === "L" ? "L" : "R";
  }).map((x) => x === "R" ? "R" : "L");
  const runs = [];
  s.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (last && last.d === d[i]) last.c.push(c);
    else runs.push({ d: d[i], c: [c] });
  });
  return runs.reverse().map((r) => r.d === "R" ? r.c.reverse().map((c) => MIRROR[c] || c).join("") : r.c.join("")).join("");
}
async function docPdf(book, d, opts = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const b64 = (x) => Buffer.from(x, "base64");
  const fonts = {
    heb: await pdf.embedFont(b64(heb)),
    hebB: await pdf.embedFont(b64(hebB)),
    lat: await pdf.embedFont(b64(lat)),
    latB: await pdf.embedFont(b64(latB))
  };
  const hebHas = (c2) => HEB.test(c2) || "\u20AA\u05F4\u05F3".includes(c2);
  const fontOf = (c2, bold) => hebHas(c2) ? bold ? fonts.hebB : fonts.heb : bold ? fonts.latB : fonts.lat;
  const segs = (vis, bold) => {
    const out = [];
    for (const c2 of vis) {
      const f = fontOf(c2, bold);
      const l = out[out.length - 1];
      if (l && l.f === f) l.t += c2;
      else out.push({ f, t: c2 });
    }
    return out.map((x) => x.f === fonts.heb || x.f === fonts.hebB ? { f: x.f, t: [...x.t].reverse().join("") } : x);
  };
  const width = (text2, size, bold) => segs(visual(text2), bold).reduce((a, s) => a + s.f.widthOfTextAtSize(s.t, size), 0);
  const W = 595.28, H = 841.89, L = 42, R = W - 42;
  const gold = rgb(0.66, 0.47, 0.25), ink = rgb(0.13, 0.13, 0.13), gray = rgb(0.45, 0.45, 0.45), soft = rgb(0.98, 0.965, 0.93), head = rgb(0.945, 0.91, 0.84);
  let page, y;
  const text = (str, x, yy2, { size = 10, bold = false, color = ink, align = "right", rotate = 0, opacity = 1 } = {}) => {
    const vis = visual(str);
    const w = width(str, size, bold);
    let x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    const rad = rotate * Math.PI / 180;
    let yy0 = yy2;
    for (const s of segs(vis, bold)) {
      page.drawText(s.t, { x: x0, y: yy0, size, font: s.f, color, rotate: degrees(rotate), opacity });
      const adv = s.f.widthOfTextAtSize(s.t, size);
      x0 += adv * Math.cos(rad);
      yy0 += adv * Math.sin(rad);
    }
    return w;
  };
  const wrap = (str, w, size, bold) => {
    const words = String(str ?? "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const wd of words) {
      const t = cur ? cur + " " + wd : wd;
      if (width(t, size, bold) <= w || !cur) cur = t;
      else {
        lines.push(cur);
        cur = wd;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const money2 = (n) => "\u20AA" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const heDate2 = (s) => s ? String(s).slice(0, 10).split("-").reverse().join("/") : "";
  const num2 = (d.series === "test" ? "T-" : "") + d.number;
  const label = DOC_LABELS[d.type] || "\u05DE\u05E1\u05DE\u05DA";
  const lined = ["320", "305", "330", "300"].includes(String(d.type));
  const paid = ["320", "400"].includes(String(d.type));
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - 48;
    if (d.series === "test") {
      const wm = "\u05DE\u05E1\u05DE\u05DA \u05E0\u05D9\u05E1\u05D9\u05D5\u05DF \xB7 \u05DC\u05D0 \u05DC\u05E6\u05D5\u05E8\u05DB\u05D9 \u05DE\u05E1", a = 24 * Math.PI / 180, ww = width(wm, 40, true);
      text(wm, W / 2 - ww / 2 * Math.cos(a), H / 2 - ww / 2 * Math.sin(a), { size: 40, bold: true, color: rgb(0.78, 0.16, 0.16), align: "left", rotate: 24, opacity: 0.16 });
    }
  };
  const need = (h) => {
    if (y - h < 90) {
      footer();
      newPage();
    }
  };
  const footer = () => {
    page.drawLine({ start: { x: L, y: 62 }, end: { x: R, y: 62 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    text(`\u05D4\u05D5\u05E4\u05E7 \u05D1-Tizon Books${opts.version ? " " + opts.version : ""} \xB7 ${new Date(d.createdAt || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" }).replace(",", "")}`, R, 48, { size: 8, color: gray });
    text(`\u05E7\u05D5\u05D3 \u05D0\u05D9\u05DE\u05D5\u05EA ${d.stamp || ""}`, L, 48, { size: 8, color: gray, align: "left" });
    text("\u05DE\u05E1\u05DE\u05DA \u05DE\u05DE\u05D5\u05D7\u05E9\u05D1, \u05D7\u05EA\u05D5\u05DD \u05D1\u05D7\u05EA\u05D9\u05DE\u05D4 \u05D0\u05DC\u05E7\u05D8\u05E8\u05D5\u05E0\u05D9\u05EA \u05DE\u05D0\u05D5\u05D1\u05D8\u05D7\u05EA", W / 2, 34, { size: 8, color: gray, align: "center" });
  };
  newPage();
  const bizName = book.legalName || book.name || "";
  text(bizName, R, y, { size: 18, bold: true, color: rgb(0.43, 0.3, 0.13) });
  y -= 18;
  for (const ln of [`${DEALERS[book.dealerType] || ""} ${book.taxId || ""}`.trim(), book.address || "", [book.phone, book.email].filter(Boolean).join(" \xB7 ")].filter(Boolean)) {
    text(ln, R, y, { size: 9.5, color: gray });
    y -= 13;
  }
  if (book.logo && /^data:image\/(png|jpe?g);base64,/.test(book.logo)) {
    try {
      const bytes = Buffer.from(book.logo.split(",")[1], "base64");
      const img = /png/.test(book.logo.slice(0, 20)) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const s = Math.min(150 / img.width, 60 / img.height);
      page.drawImage(img, { x: L, y: H - 48 - img.height * s + 14, width: img.width * s, height: img.height * s });
    } catch {
    }
  }
  y = Math.min(y, H - 48 - 62);
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 2.5, color: gold });
  y -= 30;
  const tw = text(`${label} \u05DE\u05E1\u05F3 ${num2}`, R, y, { size: 20, bold: true });
  const badge = opts.copy ? "\u05D4\u05E2\u05EA\u05E7 \u05E0\u05D0\u05DE\u05DF \u05DC\u05DE\u05E7\u05D5\u05E8" : "\u05DE\u05E7\u05D5\u05E8";
  const bw = width(badge, 11, true) + 16, bx = R - tw - 12 - bw;
  page.drawRectangle({ x: bx, y: y - 5, width: bw, height: 20, borderColor: gold, borderWidth: 1.5 });
  text(badge, bx + bw / 2, y + 1, { size: 11, bold: true, color: gold, align: "center" });
  y -= 22;
  const c = d.customer || {};
  const custLines = [c.taxId ? `\u05D7.\u05E4./\u05EA.\u05D6. ${c.taxId}` : "", c.address || "", c.phone || "", c.email || ""].filter(Boolean);
  const boxH = 30 + 13 * Math.max(custLines.length, d.allocationNo ? 3 : 1) + 8;
  page.drawRectangle({ x: L, y: y - boxH, width: R - L, height: boxH, color: soft });
  let yy = y - 16;
  text("\u05DC\u05DB\u05D1\u05D5\u05D3", R - 12, yy, { size: 9, color: gray });
  text("\u05EA\u05D0\u05E8\u05D9\u05DA", L + 150, yy, { size: 9, color: gray });
  yy -= 15;
  text(c.name || "", R - 12, yy, { size: 12, bold: true });
  text(heDate2(d.date), L + 150, yy, { size: 12, bold: true });
  let yl = yy;
  for (const ln of custLines) {
    yy -= 13;
    text(ln, R - 12, yy, { size: 9.5 });
  }
  if (d.allocationNo) {
    yl -= 16;
    text("\u05DE\u05E1\u05E4\u05E8 \u05D4\u05E7\u05E6\u05D0\u05D4", L + 150, yl, { size: 9, color: gray });
    yl -= 13;
    text(String(d.allocationNo).slice(-9), L + 150, yl, { size: 11, bold: true });
  }
  y -= boxH + 16;
  if (d.refTitle) {
    text(`${d.type === "330" ? "\u05D6\u05D9\u05DB\u05D5\u05D9 \u05D1\u05D2\u05D9\u05DF" : "\u05EA\u05E9\u05DC\u05D5\u05DD \u05E2\u05D1\u05D5\u05E8"} ${d.refTitle}`, R, y, { size: 10 });
    y -= 18;
  }
  const table = (cols, rows) => {
    const xs = [];
    let x = R;
    cols.forEach(([, w]) => {
      xs.push([x - w, x]);
      x -= w;
    });
    need(24);
    page.drawRectangle({ x: L, y: y - 7, width: R - L, height: 20, color: head });
    cols.forEach(([t, , al], i) => text(t, al === "left" ? xs[i][0] + 6 : xs[i][1] - 6, y, { size: 9, bold: true, align: al === "left" ? "left" : "right" }));
    y -= 20;
    for (const r of rows) {
      const cells = r.map((v, i) => i === 0 ? wrap(v, xs[0][1] - xs[0][0] - 12, 10) : [String(v ?? "")]);
      const h = 14 * Math.max(...cells.map((x2) => x2.length)) + 6;
      need(h);
      cells.forEach((ls, i) => ls.forEach((ln, k) => text(ln, cols[i][2] === "left" ? xs[i][0] + 6 : xs[i][1] - 6, y - 14 * k, { size: 10, align: cols[i][2] === "left" ? "left" : "right" })));
      y -= h;
      page.drawLine({ start: { x: L, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 0.5, color: rgb(0.92, 0.92, 0.92) });
    }
    y -= 6;
  };
  const sumRow = (lab, val, big) => {
    need(20);
    if (big) page.drawLine({ start: { x: L, y: y + 14 }, end: { x: L + 230, y: y + 14 }, thickness: 1.5, color: ink });
    text(lab, L + 230, y, { size: big ? 13 : 10, bold: !!big });
    text(val, L, y, { size: big ? 13 : 10, bold: !!big, align: "left" });
    y -= big ? 22 : 16;
  };
  if (lined) {
    table(
      [["\u05EA\u05D9\u05D0\u05D5\u05E8", R - L - 250], ["\u05DB\u05DE\u05D5\u05EA", 60, "left"], ["\u05DE\u05D7\u05D9\u05E8 \u05DC\u05D9\u05D7\u05D9\u05D3\u05D4", 95, "left"], ["\u05E1\u05D4\u05F4\u05DB", 95, "left"]],
      (d.lines || []).map((l) => [l.desc, String(l.qty), money2(l.price), money2((Number(l.qty) || 0) * (Number(l.price) || 0))])
    );
    y -= 4;
    if (d.vatRate) {
      sumRow(d.incl ? "\u05E1\u05D4\u05F4\u05DB \u05DC\u05E4\u05E0\u05D9 \u05DE\u05E2\u05F4\u05DE" : "\u05E1\u05D4\u05F4\u05DB", money2(d.net));
      sumRow(`\u05DE\u05E2\u05F4\u05DE ${d.vatRate}%`, money2(d.vat));
    }
    sumRow(d.type === "330" ? "\u05E1\u05D4\u05F4\u05DB \u05D6\u05D9\u05DB\u05D5\u05D9" : "\u05E1\u05D4\u05F4\u05DB \u05DC\u05EA\u05E9\u05DC\u05D5\u05DD", money2(d.total), true);
  }
  if (paid && (d.payments || []).length) {
    y -= 8;
    need(40);
    text("\u05E4\u05E8\u05D8\u05D9 \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD", R, y, { size: 12, bold: true });
    y -= 20;
    table(
      [["\u05D0\u05DE\u05E6\u05E2\u05D9", 110], ["\u05EA\u05D0\u05E8\u05D9\u05DA", 80], ["\u05E4\u05E8\u05D8\u05D9\u05DD", R - L - 300], ["\u05E1\u05DB\u05D5\u05DD", 110, "left"]],
      d.payments.map((p) => [p.kind, heDate2(p.date), p.details || "", money2(p.amount)])
    );
    if (!lined) sumRow("\u05E1\u05D4\u05F4\u05DB \u05D4\u05EA\u05E7\u05D1\u05DC", money2(d.total), true);
  }
  if (d.notes) {
    const ls = wrap(d.notes, R - L - 24, 10);
    need(14 * ls.length + 16);
    page.drawRectangle({ x: L, y: y - 14 * ls.length + 4, width: R - L, height: 14 * ls.length + 10, color: soft });
    ls.forEach((ln, k) => text(ln, R - 12, y - 14 * k, { size: 10 }));
    y -= 14 * ls.length + 16;
  }
  footer();
  pdf.setTitle(`${label} ${num2}`);
  pdf.setCreator("Tizon Books" + (opts.version ? " " + opts.version : ""));
  pdf.setAuthor(bizName);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// netlify/lib/icount.mjs
var BASE = "https://api.icount.co.il/api/v3.php";
var IC_TYPES = { invoice: "305", invrec: "320", receipt: "400", refund: "330", deal: "300" };
async function icountCall(token2, path, body, fetchImpl = fetch) {
  const r = await fetchImpl(BASE + path, {
    method: "POST",
    headers: { authorization: "Bearer " + token2, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let j;
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("icount: not json (" + r.status + ")"), { status: 502 });
  }
  if (j?.status === false && j?.reason === "no_results_found") return { ...j, empty: true };
  if (!r.ok || j?.status === false) throw Object.assign(new Error("icount: " + [j?.reason, j?.error_description || j?.message, !j?.reason ? "HTTP " + r.status : ""].filter(Boolean).join(" \xB7 ")), { status: r.status === 401 ? 401 : 400 });
  return j;
}
var num = (v) => {
  const n = Number(String(v ?? "").replace(/[,₪\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
var has = (v) => v !== void 0 && v !== null && v !== "";
var pick = (o, ...ks) => {
  for (const k of ks) if (o && has(o[k])) return o[k];
  return void 0;
};
function isoDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{9,}$/.test(s)) {
    const d = new Date(Number(s) * (s.length > 11 ? 1 : 1e3));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return "";
}
var listOf = (x) => Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : [];
function mapDoc(d) {
  const kind = String(pick(d, "doctype", "doc_type", "type") || "").toLowerCase();
  const type = IC_TYPES[kind];
  if (!type) return null;
  const c = d.client && typeof d.client === "object" ? d.client : {};
  const vat = num(pick(d, "totalvat", "total_vat", "vat", "vat_sum", "vat_amount"));
  const withVat = pick(d, "totalwithvat", "total_with_vat", "sum_with_vat");
  let total, net;
  if (has(withVat)) {
    total = num(withVat);
    net = has(pick(d, "totalsum", "total_without_vat", "sum_without_vat")) ? num(pick(d, "totalsum", "total_without_vat", "sum_without_vat")) : total - vat;
  } else {
    total = num(pick(d, "total", "totalsum", "sum", "amount", "totalpaid"));
    net = total - vat;
  }
  const lines = listOf(pick(d, "items", "doc_items")).map((it) => ({
    desc: String(pick(it, "description", "name", "item_name", "details") || "\u05E9\u05D5\u05E8\u05D4"),
    qty: num(pick(it, "quantity", "qty")) || 1,
    price: num(pick(it, "unitprice", "unit_price", "price", "unitprice_novat"))
  }));
  const sum = lines.reduce((a, l) => a + l.qty * l.price, 0);
  if (vat && lines.length && Math.abs(sum - total) < 0.05 && Math.abs(sum - net) > 0.05) lines.forEach((l) => {
    l.price = Math.round(l.price / (total / net) * 100) / 100;
  });
  const payments = [];
  const pay = (kind2, arr, f = (p) => p) => listOf(arr).forEach((p) => {
    const a = num(pick(f(p), "sum", "amount", "total"));
    if (a) payments.push({ kind: kind2, amount: a, date: isoDate(pick(f(p), "date", "paydate", "payment_date")) || isoDate(pick(d, "dateissued", "doc_date", "date")), details: String(pick(f(p), "card_number", "cc_last4", "cheque_num", "num", "reference") || "") });
  });
  if (d.cash && has(pick(d.cash, "sum"))) payments.push({ kind: "\u05DE\u05D6\u05D5\u05DE\u05DF", amount: num(d.cash.sum), date: isoDate(pick(d, "dateissued", "doc_date", "date")), details: "" });
  pay("\u05DB\u05E8\u05D8\u05D9\u05E1 \u05D0\u05E9\u05E8\u05D0\u05D9", d.cc && !Array.isArray(d.cc) && has(d.cc.sum) ? [d.cc] : d.cc);
  pay("\u05E6\u05F3\u05E7", d.cheques || d.checks);
  pay("\u05D4\u05E2\u05D1\u05E8\u05D4 \u05D1\u05E0\u05E7\u05D0\u05D9\u05EA", d.banktransfer && !Array.isArray(d.banktransfer) && has(d.banktransfer.sum) ? [d.banktransfer] : d.banktransfer || d.bank_transfers);
  pay("\u05D0\u05D7\u05E8", d.other || d.paypal);
  if (!payments.length && ["320", "400"].includes(type)) payments.push({ kind: "\u05DC\u05E4\u05D9 iCount", amount: total, date: isoDate(pick(d, "dateissued", "doc_date", "date")), details: "" });
  return {
    type,
    num: String(pick(d, "docnum", "doc_number", "number") ?? ""),
    date: isoDate(pick(d, "dateissued", "doc_date", "date", "issue_date", "created")),
    customer: {
      name: String(pick(d, "client_name", "clientname", "name") ?? pick(c, "client_name", "name") ?? ""),
      taxId: String(pick(d, "vat_id", "client_vat_id", "client_vatid") ?? pick(c, "vat_id") ?? ""),
      email: String(pick(d, "email", "client_email") ?? pick(c, "email") ?? ""),
      phone: String(pick(d, "phone", "client_phone", "mobile") ?? pick(c, "phone") ?? ""),
      address: String(pick(d, "client_address", "address") ?? "")
    },
    lines,
    payments,
    total,
    vat,
    net,
    withholding: num(pick(d, "tax_deduction", "withholding", "deduction")),
    cancelled: [1, "1", true, "true"].includes(pick(d, "is_cancelled", "cancelled", "canceled")),
    base: null,
    pdf: String(pick(d, "pdf_link", "doc_url", "url") || "")
  };
}
async function icountDocs(token2, from, to, fetchImpl = fetch) {
  const r = await icountCall(token2, "/doc/search", { start_date: from, end_date: to, max_results: 1e3, detail_level: 10 }, fetchImpl);
  if (r.empty) return { docs: [], raw: null, count: 0 };
  const list = listOf(pick(r, "results_list", "docs", "data", "results") || []);
  const docs = list.map(mapDoc).filter((x) => x && x.num);
  return { docs, raw: list[0] || null, count: list.length, skipped: list.length - docs.length };
}

// netlify/lib/store.mjs
var STORE_KEY = "AIzaSyDiXMoYgZfMKV5vL58Viyxuztl3RI3DsB0";
var STORE_PROJECT = "tizonshoponline";
var FS = (p) => `https://firestore.googleapis.com/v1/projects/${STORE_PROJECT}/databases/(default)/documents/${p}`;
var tenantId = (v) => {
  const t = String(v || "").trim();
  return !t ? "" : /[/:.]/.test(t) ? "main" : t;
};
var READABLE = ["orders", "documents", "customers"];
async function storeSignIn(email, password, fetchImpl = fetch, key = STORE_KEY) {
  const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refreshToken) throw Object.assign(new Error("store-login: " + (j.error?.message || r.status)), { status: 400 });
  return { refreshToken: j.refreshToken, email: j.email || email, uid: j.localId };
}
async function storeToken(link, fetchImpl = fetch, key = STORE_KEY) {
  const r = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: link.refreshToken }).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw Object.assign(new Error("store-token: " + (j.error?.message || r.status)), { status: 401 });
  return { idToken: j.id_token, refreshToken: j.refresh_token || link.refreshToken, exp: Date.now() + (Number(j.expires_in) || 3600) * 1e3 - 6e4 };
}
function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) {
    const d = new Date(v.timestampValue);
    if (isNaN(d)) return v.timestampValue;
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
  }
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}
var fromFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));
function toValue(x) {
  if (x === null || x === void 0) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  if (typeof x === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toValue(v)])) } };
  return { stringValue: String(x) };
}
async function storeList(idToken, tenant, name, fetchImpl = fetch) {
  const t = tenantId(tenant);
  if (!/^[\w-]{1,80}$/.test(t) || !READABLE.includes(name)) throw Object.assign(new Error("bad path"), { status: 400 });
  const out = [];
  let page = "";
  for (let i = 0; i < 60; i++) {
    const r = await fetchImpl(
      FS(`tenants/${t}/${name}`) + `?pageSize=300${page ? "&pageToken=" + encodeURIComponent(page) : ""}`,
      { headers: { authorization: "Bearer " + idToken } }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(String(j.error?.status || j.error?.message || r.status).toLowerCase().replace(/_/g, "-")), { status: r.status === 403 ? 403 : 502 });
    (j.documents || []).forEach((d) => out.push({ ...fromFields(d.fields), id: d.name.split("/").pop() }));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}
var storeDocId = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 90);
async function storeCreateCustomer(idToken, tenant, c, fetchImpl = fetch) {
  const t = tenantId(tenant);
  if (!/^[\w-]{1,80}$/.test(t)) throw Object.assign(new Error("bad tenant"), { status: 400 });
  const rec = Object.fromEntries(Object.entries({
    name: String(c.name || "").slice(0, 120),
    email: String(c.email || "").slice(0, 120),
    phone: String(c.phone || "").slice(0, 30),
    address: [c.address, c.city].filter(Boolean).join(", ").slice(0, 200),
    notes: "\u05E0\u05D5\u05E1\u05E3 \u05DE-Tizon Books",
    createdAt: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    source: "tizon-books"
  }).filter(([, v]) => v !== ""));
  const base = storeDocId(c.email) || "c_" + Date.now().toString(36);
  for (let i = 0; i < 4; i++) {
    const id = i === 0 ? base : base + "_" + Math.random().toString(36).slice(2, 7);
    const r = await fetchImpl(FS(`tenants/${t}/customers`) + `?documentId=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { authorization: "Bearer " + idToken, "content-type": "application/json" },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, toValue(v)])) })
    });
    if (r.ok) return id;
    const j = await r.json().catch(() => ({}));
    if (r.status !== 409) throw Object.assign(new Error(String(j.error?.status || r.status).toLowerCase()), { status: r.status === 403 ? 403 : 502 });
  }
  throw Object.assign(new Error("id taken"), { status: 409 });
}

// netlify/lib/inbox.mjs
var MAX_FILE = 4.2 * 1024 * 1024;
var OK_MIME = /^(application\/pdf|image\/(jpe?g|png|webp|heic|heif))$/i;
var idOk = (s) => /^[\w.-]{1,120}$/.test(String(s || ""));
var keyName = (b) => "inbox-key:" + b;
var idxName = (b) => "inbox:" + b;
var fileName = (b, id) => "inboxf:" + b + ":" + id;
async function readIndex(store, b) {
  const x = await store.get(idxName(b), { type: "json" }).catch(() => null);
  return Array.isArray(x?.items) ? x : { items: [], lastAt: null };
}
var writeIndex = (store, b, x) => store.setJSON(idxName(b), x);
function parseFrom(s) {
  const t = String(s || "").trim();
  const m = t.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : t).trim().toLowerCase();
  const name = (m ? m[1] : "").trim();
  return { name: name || email.split("@")[0], email: /@/.test(email) ? email : "" };
}
async function inboxPush(store, b, key, body) {
  if (!idOk(b)) return { status: 400, body: { error: "book" } };
  const want = await store.get(keyName(b), { type: "json" }).catch(() => null);
  if (!want?.key || !key || key !== want.key) return { status: 403, body: { error: "key" } };
  const id = String(body?.id || "");
  if (!idOk(id)) return { status: 400, body: { error: "id" } };
  const mime = String(body?.mime || "").toLowerCase();
  if (!OK_MIME.test(mime)) return { status: 200, body: { ok: true, skipped: "type" } };
  const data = String(body?.data || "");
  const size = Math.floor(data.length * 3 / 4);
  if (!data || size > MAX_FILE) return { status: 200, body: { ok: true, skipped: "size" } };
  const idx = await readIndex(store, b);
  if (idx.items.some((x) => x.id === id)) return { status: 200, body: { ok: true, dup: true } };
  const from = parseFrom(body.from);
  const item = {
    id,
    from: from.email,
    fromName: from.name.slice(0, 120),
    subject: String(body.subject || "").slice(0, 200),
    date: String(body.date || "").slice(0, 40),
    name: String(body.name || "file").slice(0, 160),
    mime,
    size,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    status: "new"
  };
  await store.set(fileName(b, id), data);
  idx.items.push(item);
  idx.lastAt = item.at;
  if (idx.items.length > 1500) idx.items = [...idx.items.filter((x) => x.status === "new"), ...idx.items.filter((x) => x.status !== "new").slice(-800)];
  await writeIndex(store, b, idx);
  return { status: 200, body: { ok: true } };
}
async function inboxFile(store, b, id) {
  if (!idOk(b) || !idOk(id)) return null;
  const data = await store.get(fileName(b, id)).catch(() => null);
  if (!data) return null;
  const idx = await readIndex(store, b);
  const it = idx.items.find((x) => x.id === id);
  return { data: String(data), mime: it?.mime || "application/octet-stream", name: it?.name || "file" };
}
async function inboxMark(store, b, id, status, expenseId) {
  if (!["done", "ignored", "new"].includes(status)) return false;
  const idx = await readIndex(store, b);
  const it = idx.items.find((x) => x.id === id);
  if (!it) return false;
  it.status = status;
  it.expenseId = status === "done" ? String(expenseId || "") : "";
  it.handledAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeIndex(store, b, idx);
  return true;
}

// netlify/functions/books-mail.mjs
var VERSION = "1.19.0";
var JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
var env = (k) => (process.env[k] || "").trim();
var json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});
var storeOverride = null;
var secrets = () => storeOverride || getStore({ name: "books-secrets", consistency: "strong" });
var inboxStore = () => storeOverride || getStore({ name: "books-inbox", consistency: "strong" });
async function certB64() {
  if (env("SIGN_P12_BASE64")) return env("SIGN_P12_BASE64");
  try {
    return await secrets().get("cert.p12") || "";
  } catch {
    return "";
  }
}
function certInfo(b64, pass) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(b64)), pass);
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keys = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  const c = bags[0]?.cert;
  if (!c || !keys.length) throw new Error("no key or certificate in file");
  const cn = c.subject.getField("CN")?.value || "";
  const issuer = c.issuer.getField("CN")?.value || c.issuer.getField("O")?.value || "";
  return { name: forge.util.decodeUtf8(cn), issuer: forge.util.decodeUtf8(issuer), expires: c.validity.notAfter.toISOString() };
}
/* The certificate's password: from Netlify's settings, or as typed in the app (kept here, with the certificate). */
async function certPass() {
  if (env("SIGN_P12_PASSWORD")) return env("SIGN_P12_PASSWORD");
  try {
    return await secrets().get("cert.pass") || "";
  } catch {
    return "";
  }
}
async function signState() {
  const b = await certB64(), pass = await certPass();
  if (!b || !pass) return { sign: false };
  try {
    return { sign: true, cert: certInfo(b, pass) };
  } catch (e) {
    return { sign: false, certError: String(e.message || e) };
  }
}
var mailReady = () => !!(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));
var projectId = () => env("BOOKS_PROJECT_ID") || "tizonfinance";
var whoOverride = null;
var dbOverride = null;
var mailOverride = null;
var fetchOverride = null;
var __test = {
  setStore: (s) => {
    storeOverride = s;
  },
  setWho: (f) => {
    whoOverride = f;
  },
  setDb: (d) => {
    dbOverride = d;
  },
  setMail: (m) => {
    mailOverride = m;
  },
  setFetch: (f) => {
    fetchOverride = f;
  }
};
async function saJson() {
  const raw = env("FIREBASE_SERVICE_ACCOUNT") ? Buffer.from(env("FIREBASE_SERVICE_ACCOUNT"), "base64").toString("utf8") : await secrets().get("sa.json").catch(() => null);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j.private_key && j.client_email ? j : null;
  } catch {
    return null;
  }
}
var adminCache = null;
async function adminDb() {
  if (dbOverride) return dbOverride;
  if (adminCache) return adminCache;
  const sa = await saJson();
  if (!sa) throw Object.assign(new Error("no-service-account"), { status: 400 });
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = getApps().find((a) => a.name === "books") || initializeApp({ credential: cert(sa), projectId: sa.project_id }, "books");
  adminCache = adminAdapter(getFirestore(app));
  return adminCache;
}
var sendMail = async (m) => {
  if (mailOverride) return mailOverride(m);
  if (!mailReady()) throw new Error("no-mail");
  return mailer().sendMail({ from: env("MAIL_FROM") || env("SMTP_USER"), ...m });
};
var storeCache = null;
var storeLink = async () => secrets().get("store-link", { type: "json" }).catch(() => null);
async function storeId() {
  if (storeCache && storeCache.exp > Date.now()) return storeCache.idToken;
  const link = await storeLink();
  if (!link?.refreshToken) throw Object.assign(new Error("store-not-linked"), { status: 400 });
  const t = await storeToken(link, fetchOverride || fetch);
  if (t.refreshToken !== link.refreshToken) await secrets().setJSON("store-link", { ...link, refreshToken: t.refreshToken });
  storeCache = t;
  return t.idToken;
}
var BOOKS_WEB_KEY = env("BOOKS_WEB_KEY") || "AIzaSyAOph6_Dr2ChyEi2iFF4yDT-p9jk3uDd3k";
var FSB = (p) => `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents${p}?key=${BOOKS_WEB_KEY}`;
async function fsFetch(url, opts) {
  const f = fetchOverride || fetch;
  let r = await f(url, opts);
  if (r.status === 429 || r.status === 503) {
    await new Promise((res) => setTimeout(res, 700));
    r = await f(url, opts);
  }
  return r;
}
var roleCache = /* @__PURE__ */ new Map();
async function bookAs(idToken, bookId) {
  if (!/^[\w-]{1,80}$/.test(bookId)) return null;
  const r = await fsFetch(FSB("/books/" + bookId), { headers: { authorization: "Bearer " + idToken } });
  if (!r.ok) {
    if (lastRole) lastRole.http = r.status;
    return null;
  }
  const j = await r.json().catch(() => null);
  return j?.fields ? { ...fromFields(j.fields), id: bookId } : null;
}
async function booksAs(idToken, email) {
  const out = {};
  for (const f of ["owners", "clerks", "viewers"]) {
    const r = await fsFetch(FSB(":runQuery"), {
      method: "POST",
      headers: { authorization: "Bearer " + idToken, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "books" }], where: { fieldFilter: { field: { fieldPath: f }, op: "ARRAY_CONTAINS", value: { stringValue: email } } } } })
    });
    const j = await r.json().catch(() => []);
    (Array.isArray(j) ? j : []).filter((x) => x.document).forEach((x) => {
      const id = x.document.name.split("/").pop();
      out[id] = { ...fromFields(x.document.fields), id };
    });
  }
  return Object.values(out);
}
var lastRole = null;
async function roleOfBook(email, bookId, idToken) {
  const ck = email + "|" + bookId, hit = roleCache.get(ck);
  if (hit && Date.now() - hit.at < 5 * 6e4) return hit.role;
  const role = await roleOfBookNow(email, bookId, idToken);
  if (role) roleCache.set(ck, { role, at: Date.now() });
  return role;
}
async function roleOfBookNow(email, bookId, idToken) {
  lastRole = { email, book: bookId };
  const rank = { owner: 3, clerk: 2, viewer: 1, "": 0 };
  let best = "";
  if (dbOverride || await saJson()) {
    try {
      const b = /^[\w-]{1,80}$/.test(bookId) ? await (await adminDb()).get(`books/${bookId}`) : null;
      lastRole.key = b ? roleIn(b, email) || "none" : "no-book";
      if (b) best = roleIn(b, email);
    } catch (e) {
      lastRole.key = String(e.message || e).slice(0, 80);
    }
  }
  if (best !== "owner" && idToken) {
    const b = await bookAs(idToken, bookId);
    lastRole.login = b ? roleIn(b, email) || "none" : "no-book";
    if (b) lastRole.owners = b.owners;
    if (b && rank[roleIn(b, email)] > rank[best]) best = roleIn(b, email);
  }
  return best;
}
async function ownsAny(email, idToken) {
  if (env("ALLOWED_EMAILS")) return true;
  if (dbOverride || await saJson()) return (await (await adminDb()).list("books")).some((b) => roleIn(b, email) === "owner");
  return (await booksAs(idToken, email)).some((b) => roleIn(b, email) === "owner");
}
async function mayUseStore(email, tenant, idToken) {
  const books = dbOverride || await saJson() ? await (await adminDb()).list("books") : await booksAs(idToken, email);
  return books.some((b) => tenantId(b.tenant) === tenantId(tenant) && roleIn(b, email));
}
var upCredsOf = async (book) => {
  const v = await secrets().get("up:" + book, { type: "json" }).catch(() => null);
  return v && v.email ? { email: v.email, key: v.key || "" } : null;
};
var zcKeyOf = async (book) => (await secrets().get("zc:" + book, { type: "json" }).catch(() => null))?.key || "";
var baseOf = (url) => env("URL") || url.origin;
var html = (status, body) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
async function who(token2) {
  if (whoOverride) return whoOverride(token2);
  const pid = projectId();
  const { payload } = await jwtVerify(token2, JWKS, { issuer: `https://securetoken.google.com/${pid}`, audience: pid });
  const email = String(payload.email || "").toLowerCase();
  const allow = env("ALLOWED_EMAILS").toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!email || allow.length && !allow.includes(email)) throw Object.assign(new Error("not allowed"), { status: 403 });
  return email;
}
async function signPdf(pdf, info = {}) {
  const doc = await PDFDocument2.load(pdf);
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: info.reason || "\u05DE\u05E1\u05DE\u05DA \u05DE\u05DE\u05D5\u05D7\u05E9\u05D1",
    contactInfo: info.contact || "",
    name: env("SIGN_NAME") || info.name || "",
    location: info.location || "Israel",
    signatureLength: 16384
  });
  const ready = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new P12Signer(Buffer.from(await certB64(), "base64"), { passphrase: await certPass() });
  return Buffer.from(await new SignPdf().sign(ready, signer));
}
function mailer() {
  const port = Number(env("SMTP_PORT")) || 465;
  return nodemailer.createTransport({
    host: env("SMTP_HOST"),
    port,
    secure: port === 465,
    auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") }
  });
}
var itaEnv = () => env("ITA_ENV") === "production" ? "production" : "tsandbox";
var itaAuth = () => env("ITA_AUTH_BASE") || `https://openapi.taxes.gov.il/shaam/${itaEnv()}/longtimetoken/oauth2`;
var itaApproval = () => env("ITA_APPROVAL_URL") || `https://ita-api.taxes.gov.il/shaam/${itaEnv()}/Invoices/v2/Approval`;
var itaReady = () => !!(env("ITA_CLIENT_ID") && env("ITA_CLIENT_SECRET") && env("ITA_REDIRECT_URI"));
var itaBasic = () => "Basic " + Buffer.from(env("ITA_CLIENT_ID") + ":" + env("ITA_CLIENT_SECRET")).toString("base64");
var vatKey = (v) => "ita:" + String(v || "").replace(/\D/g, "");
async function itaToken(form) {
  const r = await fetch(itaAuth() + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: itaBasic() },
    body: new URLSearchParams(form).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error("ita token: " + (j.error_description || j.error || r.status)), { status: 502 });
  const now = Date.now();
  return {
    access_token: j.access_token,
    access_exp: now + (Number(j.expires_in) || 600) * 1e3 - 3e4,
    refresh_token: j.refresh_token,
    refresh_exp: now + (Number(j.refresh_token_expires_in) || 7776e3) * 1e3
  };
}
async function itaAccess(vat) {
  const store = secrets();
  const t = await store.get(vatKey(vat), { type: "json" }).catch(() => null);
  if (!t?.refresh_token) throw Object.assign(new Error("ita-not-connected"), { status: 400 });
  if (t.access_token && t.access_exp > Date.now()) return t.access_token;
  if (t.refresh_exp && t.refresh_exp < Date.now()) throw Object.assign(new Error("ita-expired"), { status: 400 });
  const n = await itaToken({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: env("ITA_CLIENT_ID"),
    client_secret: env("ITA_CLIENT_SECRET"),
    scope: env("ITA_SCOPE") || "scope"
  });
  await store.setJSON(vatKey(vat), { ...t, ...n, refresh_token: n.refresh_token || t.refresh_token, updated: (/* @__PURE__ */ new Date()).toISOString() });
  return n.access_token;
}
var books_mail_default = async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("action") === "ita-callback") {
      const back = (q) => new Response(null, { status: 302, headers: { location: "/?" + q } });
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return back("ita=error&m=" + encodeURIComponent(url.searchParams.get("error") || "no code"));
      const st = await secrets().get("ita-state:" + state, { type: "json" }).catch(() => null);
      if (!st || Date.now() - st.at > 20 * 6e4) return back("ita=error&m=state");
      await secrets().delete("ita-state:" + state).catch(() => {
      });
      try {
        const t = await itaToken({ grant_type: "authorization_code", code, redirect_uri: env("ITA_REDIRECT_URI"), scope: env("ITA_SCOPE") || "scope" });
        await secrets().setJSON(vatKey(st.vat), { ...t, by: st.email, connected: (/* @__PURE__ */ new Date()).toISOString() });
        return back("ita=ok");
      } catch (e) {
        return back("ita=error&m=" + encodeURIComponent(e.message));
      }
    }
    const short = url.pathname.match(/\/p\/([\w-]+)\/([\w-]+)\/([\w-]+)\/?$/);
    if (short) {
      url.searchParams.set("action", "pay");
      url.searchParams.set("b", short[1]);
      url.searchParams.set("p", short[2]);
      url.searchParams.set("k", short[3]);
    }
    const act = url.searchParams.get("action");
    if (req.method === "GET" && act === "pay") {
      const b = url.searchParams.get("b") || "", p = url.searchParams.get("p") || "", k = url.searchParams.get("k") || "";
      if (!/^[\w-]{1,80}$/.test(b) || !/^[\w-]{1,80}$/.test(p)) return html(404, donePage({}));
      const db = await adminDb();
      const pay = await db.get(`books/${b}/payreqs/${p}`);
      if (!pay || !k || pay.linkKey !== k) return html(404, donePage({}));
      const book = await db.get(`books/${b}`);
      if (pay.status !== "open" || pay.upReport) return html(200, donePage({ pay, book }));
      const up = pay.provider === "upay";
      const key = up ? null : await zcKeyOf(b);
      const ucreds = up ? await upCredsOf(b) : null;
      if (up ? !ucreds : !key) return html(503, donePage({ pay: { ...pay, status: "unavailable" }, book }));
      let secret = await secrets().get(`pay:${b}:${p}`).catch(() => null);
      if (!secret) {
        secret = token(24);
        await secrets().set(`pay:${b}:${p}`, secret);
      }
      if (up && !ucreds.key) {
        /* No API key: uPay's own payment form (the "payment button" every
           account has), with this page's sum, posted for the customer. */
        const fnb = `${baseOf(url)}/.netlify/functions/books-mail`;
        const backU = `${fnb}?${new URLSearchParams({ action: "pay-up", b, p, t: secret })}`;
        const fields = { email: ucreds.email, amount: r2(pay.total).toFixed(2), returnurl: backU, ipnurl: backU + "&ipn=1",
          /* As uPay's own plugin posts this form: the customer's email and
             mobile, a short comment, and no productdescription (an API field). */
          ...(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(pay.customer?.email || "")) ? { emailnotify: pay.customer.email } : {}),
          ...(/^(05|\+9725)/.test(String(pay.customer?.phone || "").replace(/[^\d+]/g, "")) ? { cellphonenotify: String(pay.customer.phone).replace(/[^\d+]/g, "") } : {}),
          comment: p, paymentdetails: upDesc({ ...pay, id: p }),
          maxpayments: String(Math.max(1, Math.min(36, Number(pay.maxPayments) || 1))), livesystem: "1", commissionreduction: "",
          createinvoiceandreceipt: "0", createinvoice: "0", createreceipt: "0", refername: "UPAY", lang: "HE", currency: "NIS" };
        const escA = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
        await db.update(`books/${b}/payreqs/${p}`, { openedAt: (/* @__PURE__ */ new Date()).toISOString(), opens: (Number(pay.opens) || 0) + 1 }).catch(() => {
        });
        return html(200, `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u05DE\u05E2\u05D1\u05E8 \u05DC\u05EA\u05E9\u05DC\u05D5\u05DD</title></head>
<body style="font-family:Assistant,Arial,sans-serif;text-align:center;padding:60px 20px;background:#f7f3ea;color:#6e4d22"><h2>\u05E2\u05D5\u05D1\u05E8\u05D9\u05DD \u05DC\u05E2\u05DE\u05D5\u05D3 \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05D4\u05DE\u05D0\u05D5\u05D1\u05D8\u05D7\u2026</h2>
<form id="f" action="https://app.upay.co.il/API6/clientsecure/redirectpage.php" method="post">${Object.entries(fields).map(([n, v]) => `<input type="hidden" name="${escA(n)}" value="${escA(v)}">`).join("")}<noscript><button type="submit">\u05DC\u05D4\u05DE\u05E9\u05DA</button></noscript></form>
<script>document.getElementById('f').submit();</script></body></html>`);
      }
      if (up) {
        let su;
        try { su = await upSession({ creds: ucreds, pay: { ...pay, book: b }, base: baseOf(url), secret, fetchImpl: fetchOverride || fetch }); }
        catch { return html(503, donePage({ pay: { ...pay, status: "unavailable" }, book })); }
        await db.update(`books/${b}/payreqs/${p}`, { openedAt: (/* @__PURE__ */ new Date()).toISOString(), opens: (Number(pay.opens) || 0) + 1 }).catch(() => {
        });
        return new Response(null, { status: 302, headers: { location: su.url, "cache-control": "no-store" } });
      }
      const s = await zcSession({ key, pay: { ...pay, book: b }, base: baseOf(url), secret, fetchImpl: fetchOverride || fetch, url: env("ZCREDIT_URL") || ZC_URL });
      await db.update(`books/${b}/payreqs/${p}`, { openedAt: (/* @__PURE__ */ new Date()).toISOString(), opens: (Number(pay.opens) || 0) + 1, sessionId: s.sessionId }).catch(() => {
      });
      return new Response(null, { status: 302, headers: { location: s.url, "cache-control": "no-store" } });
    }
    if (req.method === "GET" && act === "pay-done") {
      const b = url.searchParams.get("b") || "", p = url.searchParams.get("p") || "";
      if (!/^[\w-]{1,80}$/.test(b) || !/^[\w-]{1,80}$/.test(p)) return html(404, donePage({}));
      const db = await adminDb();
      const pay = await db.get(`books/${b}/payreqs/${p}`);
      const book = pay ? await db.get(`books/${b}`) : null;
      return html(200, donePage({ pay, book, cancel: url.searchParams.get("cancel") === "1" }));
    }
    if (act === "pay-up") {
      /* uPay sends the customer back here, and calls here server to server
         (ipn=1). The transaction is asked for from uPay; only a confirmed one,
         for this page and its sum, goes on to the same issuing as Z-Credit's. */
      const b = url.searchParams.get("b") || "", p = url.searchParams.get("p") || "";
      const ipn = url.searchParams.get("ipn") === "1";
      const q = Object.fromEntries(url.searchParams);
      if (req.method === "POST") {
        const raw = await req.text().catch(() => "");
        try { Object.assign(q, JSON.parse(raw)); } catch { try { for (const [k2, v2] of new URLSearchParams(raw)) if (!(k2 in q)) q[k2] = v2; } catch {} }
      }
      const done = (cancel) => ipn ? json(200, { ok: !cancel }) : new Response(null, { status: 302, headers: { location: `${baseOf(url)}/.netlify/functions/books-mail?${new URLSearchParams({ action: "pay-done", b, p, ...(cancel ? { cancel: "1" } : {}) })}`, "cache-control": "no-store" } });
      if (!/^[\w-]{1,80}$/.test(b) || !/^[\w-]{1,80}$/.test(p)) return done(true);
      const kept = await secrets().get(`pay:${b}:${p}`).catch(() => null);
      const secret = url.searchParams.get("t") || "";
      if (!kept || !secret || sha(secret) !== sha(kept)) return done(true);
      const trx = String(q.transactionid || q.cashierid || "");
      if (q.errormessage || String(q.providererrordescription || "").toUpperCase() !== "SUCCESS" || !trx) return done(true);
      const db = await adminDb();
      const pay = await db.get(`books/${b}/payreqs/${p}`);
      if (!pay) return done(true);
      if (pay.status === "paid") return done(false);
      const ucreds = await upCredsOf(b);
      if (ucreds && !ucreds.key) {
        /* Nothing to ask uPay with: the report is kept on the page, the owner
           is told, and the invoice waits for their confirmation. */
        if (!pay.upReport) {
          const amt = Number(q.amount);
          await db.update(`books/${b}/payreqs/${p}`, { upReport: { trx, amount: Number.isFinite(amt) ? r2(amt) : null, at: (/* @__PURE__ */ new Date()).toISOString() } }).catch(() => {
          });
          await (mailOverride || mailReady() ? sendMail : null)?.({
            to: pay.createdBy,
            subject: `Tizon Books \xB7 \u05D9\u05D5\u05E4\u05D9\u05D9 \u05D3\u05D9\u05D5\u05D5\u05D7 \u05E2\u05DC \u05EA\u05E9\u05DC\u05D5\u05DD \xB7 ${pay.customer?.name || ""}`,
            text: `\u05D9\u05D5\u05E4\u05D9\u05D9 \u05D3\u05D9\u05D5\u05D5\u05D7 \u05E2\u05DC \u05EA\u05E9\u05DC\u05D5\u05DD \u05D1\u05D3\u05E3 \u05D4\u05E1\u05DC\u05D9\u05E7\u05D4 \u05E9\u05DC ${pay.customer?.name || ""} (${money(pay.total)}, \u05E2\u05E1\u05E7\u05D4 ${trx}).
\u05DC\u05D1\u05D3\u05D5\u05E7 \u05D1\u05DE\u05DE\u05E9\u05E7 \u05E9\u05DC \u05D9\u05D5\u05E4\u05D9\u05D9, \u05D5\u05D0\u05D6 \u05D1-Tizon Books \u05DC\u05DC\u05D7\u05D5\u05E5 "\u05D0\u05D9\u05E9\u05D5\u05E8 \u05D5\u05D4\u05E4\u05E7\u05EA \u05D7\u05E9\u05D1\u05D5\u05E0\u05D9\u05EA" \u05DC\u05D9\u05D3 \u05D3\u05E3 \u05D4\u05E1\u05DC\u05D9\u05E7\u05D4.`
          }).catch(() => {
          });
        }
        return done(false);
      }
      const cbBody = ucreds ? await upVerify({ creds: ucreds, pay, trx, fetchImpl: fetchOverride || fetch }).catch(() => null) : null;
      if (!cbBody) {
        await db.update(`books/${b}/payreqs/${p}`, { lastError: { at: (/* @__PURE__ */ new Date()).toISOString(), body: `uPay ${trx}: not confirmed` } }).catch(() => {
        });
        return done(true);
      }
      const itaFn2 = itaReady() ? async (inv) => {
        const tok = await itaAccess(inv.vat_number);
        const r3 = await fetch(itaApproval(), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(inv) });
        return r3.json().catch(() => ({}));
      } : null;
      const sign2 = (await signState()).sign ? (pdf, info) => signPdf(pdf, info) : null;
      await handleCallback({ bookId: b, payId: p, secret, body: cbBody }, {
        db, secretOf: (bb, pp) => secrets().get(`pay:${bb}:${pp}`).catch(() => null),
        pdf: (book, d, o) => docPdf(book, d, o), sign: sign2,
        mail: mailOverride || mailReady() ? sendMail : null, ita: itaFn2, version: VERSION
      }).catch(() => null);
      return done(false);
    }
    if (req.method === "POST" && act === "pay-callback") {
      const raw = await req.text();
      let body2 = {};
      try {
        body2 = JSON.parse(raw);
      } catch {
        body2 = Object.fromEntries(new URLSearchParams(raw));
      }
      const b = url.searchParams.get("b") || "", p = url.searchParams.get("p") || "";
      const itaFn = itaReady() ? async (inv) => {
        const tok = await itaAccess(inv.vat_number);
        const r3 = await fetch(itaApproval(), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(inv) });
        return r3.json().catch(() => ({}));
      } : null;
      const sign = (await signState()).sign ? (pdf, info) => signPdf(pdf, info) : null;
      const r = await handleCallback({ bookId: b, payId: p, secret: url.searchParams.get("t") || "", body: body2 }, {
        db: await adminDb(),
        secretOf: (bb, pp) => secrets().get(`pay:${bb}:${pp}`).catch(() => null),
        pdf: (book, d, o) => docPdf(book, d, o),
        sign,
        mail: mailOverride || mailReady() ? sendMail : null,
        ita: itaFn,
        version: VERSION
      });
      return json(r.status || 200, r);
    }
    if (req.method === "POST" && act === "inbox-push") {
      const body2 = await req.json().catch(() => ({}));
      const r = await inboxPush(inboxStore(), url.searchParams.get("b") || "", url.searchParams.get("k") || "", body2);
      return json(r.status, r.body);
    }
    if (req.method === "GET") return json(200, {
      ok: true,
      ...await signState(),
      mail: mailReady(),
      project: true,
      pay: { admin: !!(dbOverride || await saJson()) },
      inbox: true,
      store: await storeLink().then((l) => l?.refreshToken ? { linked: true, email: l.email } : { linked: false }),
      password: !!await certPass(),
      passFromApp: !env("SIGN_P12_PASSWORD"),
      guarded: !!env("ALLOWED_EMAILS"),
      ita: { configured: itaReady(), env: itaEnv() === "production" ? "production" : "sandbox" }
    });
    if (req.method !== "POST") return json(405, { error: "method" });
    const body = await req.json().catch(() => ({}));
    const email = await who(String(body.idToken || ""));
    if (body.action === "cert") {
      if (!await ownsAny(email, String(body.idToken || ""))) return json(403, { error: "owners only" });
      const pass = env("SIGN_P12_PASSWORD") || String(body.pass || "");
      if (!pass) return json(400, { error: "password" });
      const b = String(body.p12 || "");
      let info;
      try {
        info = certInfo(b, pass);
      } catch (e) {
        return json(400, { error: /password|mac|decrypt/i.test(String(e.message || e)) ? "wrong-password" : "cert: " + (e.message || e) });
      }
      await secrets().set("cert.p12", b);
      if (!env("SIGN_P12_PASSWORD")) await secrets().set("cert.pass", pass);
      return json(200, { ok: true, cert: info, by: email });
    }
    if (body.action === "doc") {
      if (!(await signState()).sign) return json(400, { error: "no-cert" });
      const pdf = Buffer.from(String(body.pdf || ""), "base64");
      if (pdf.length < 100 || pdf.length > 8 * 1024 * 1024) return json(400, { error: "bad-pdf" });
      const signed = await signPdf(pdf, { name: body.business, contact: body.businessEmail, reason: body.title });
      let sent = false;
      if (body.to) {
        if (!mailReady()) return json(400, { error: "no-mail", pdf: signed.toString("base64") });
        await mailer().sendMail({
          from: env("MAIL_FROM") || env("SMTP_USER"),
          to: String(body.to),
          replyTo: body.replyTo || void 0,
          subject: String(body.subject || body.title || "\u05DE\u05E1\u05DE\u05DA"),
          text: String(body.text || ""),
          attachments: [{ filename: String(body.filename || "document.pdf"), content: signed, contentType: "application/pdf" }]
        });
        sent = true;
      }
      return json(200, { ok: true, sent, by: email, pdf: signed.toString("base64") });
    }
    if (body.action === "ita-status") {
      if (!itaReady()) return json(200, { configured: false });
      const t = await secrets().get(vatKey(body.vat), { type: "json" }).catch(() => null);
      return json(200, {
        configured: true,
        connected: !!t?.refresh_token && (!t.refresh_exp || t.refresh_exp > Date.now()),
        expires: t?.refresh_exp ? new Date(t.refresh_exp).toISOString() : null,
        by: t?.by || null
      });
    }
    if (body.action === "ita-connect") {
      if (!itaReady()) return json(400, { error: "ita not configured" });
      if (!await ownsAny(email, String(body.idToken || ""))) return json(403, { error: "owners only" });
      const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await secrets().setJSON("ita-state:" + state, { vat: String(body.vat || "").replace(/\D/g, ""), email, at: Date.now() });
      const q = new URLSearchParams({
        response_type: "code",
        client_id: env("ITA_CLIENT_ID"),
        scope: env("ITA_SCOPE") || "scope",
        redirect_uri: env("ITA_REDIRECT_URI"),
        state
      });
      return json(200, { url: itaAuth() + "/authorize?" + q.toString() });
    }
    if (body.action === "ita-approve") {
      if (!itaReady()) return json(400, { error: "ita not configured" });
      const inv = body.invoice || {};
      const token2 = await itaAccess(inv.vat_number);
      const r = await fetch(itaApproval(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token2 },
        body: JSON.stringify(inv)
      });
      const j = await r.json().catch(() => ({}));
      return json(200, { approved: !!j.approved, confirmation_number: j.confirmation_number || "0", message: j.message, status: j.status || r.status });
    }
    if (["icount-link", "icount-docs", "icount-status"].includes(body.action)) {
      const bookId = String(body.book || "");
      const role = await roleOfBook(email, bookId, String(body.idToken || ""));
      if (body.action === "icount-link" ? role !== "owner" : !role) return json(403, { error: "owners only", detail: lastRole });
      const key = "icount:" + bookId;
      if (body.action === "icount-status") {
        const t2 = await secrets().get(key, { type: "json" }).catch(() => null);
        return json(200, { linked: !!t2?.token, at: t2?.at || null });
      }
      if (body.action === "icount-link") {
        if (body.unlink) {
          await secrets().delete(key);
          return json(200, { ok: true, linked: false });
        }
        const token2 = String(body.token || "").trim();
        if (token2.length < 10) return json(400, { error: "token" });
        const to2 = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), from2 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        let recent = null, warning = "";
        try {
          recent = (await icountDocs(token2, from2, to2, fetchOverride || fetch)).count;
        } catch (e) {
          const m = String(e.message || e);
          if (/auth|token|login|401|403|permission|denied|unauthori|invalid_(api|key|user)/i.test(m)) return json(400, { error: m });
          warning = m;
        }
        await secrets().setJSON(key, { token: token2, by: email, at: (/* @__PURE__ */ new Date()).toISOString() });
        return json(200, { ok: true, linked: true, recent, warning });
      }
      const t = await secrets().get(key, { type: "json" }).catch(() => null);
      if (!t?.token) return json(400, { error: "icount-not-linked" });
      const from = String(body.from || ""), to = String(body.to || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json(400, { error: "dates" });
      return json(200, { ok: true, ...await icountDocs(t.token, from, to, fetchOverride || fetch) });
    }
    if (["inbox-key", "inbox-list", "inbox-file", "inbox-mark"].includes(body.action)) {
      const bookId = String(body.book || "");
      const role = await roleOfBook(email, bookId, String(body.idToken || ""));
      if (!role || body.action === "inbox-key" && role !== "owner" || body.action === "inbox-mark" && !["owner", "clerk"].includes(role))
        return json(403, { error: "not allowed", detail: lastRole });
      const st = inboxStore();
      if (body.action === "inbox-key") {
        let k = await secrets().get(keyName(bookId), { type: "json" }).catch(() => null);
        if (!k?.key || body.renew) {
          k = { key: token(32), by: email, at: (/* @__PURE__ */ new Date()).toISOString() };
          await st.setJSON(keyName(bookId), k);
          await secrets().setJSON(keyName(bookId), k);
        }
        const idx = await readIndex(st, bookId);
        return json(200, { ok: true, key: k.key, at: k.at, lastAt: idx.lastAt, count: idx.items.length });
      }
      if (body.action === "inbox-list") {
        const idx = await readIndex(st, bookId);
        const keyed = !!(await secrets().get(keyName(bookId), { type: "json" }).catch(() => null))?.key;
        return json(200, { ok: true, keyed, lastAt: idx.lastAt, items: idx.items.filter((x) => body.all || x.status === "new") });
      }
      if (body.action === "inbox-file") {
        const f = await inboxFile(st, bookId, String(body.id || ""));
        return f ? json(200, { ok: true, ...f }) : json(404, { error: "not found" });
      }
      const ok = await inboxMark(st, bookId, String(body.id || ""), String(body.status || ""), body.expenseId);
      return ok ? json(200, { ok: true }) : json(404, { error: "not found" });
    }
    if (body.action === "store-link") {
      if (!await ownsAny(email, String(body.idToken || ""))) return json(403, { error: "owners only" });
      if (body.unlink) {
        await secrets().delete("store-link");
        storeCache = null;
        return json(200, { ok: true, linked: false });
      }
      const r = await storeSignIn(String(body.email || "").trim(), String(body.password || ""), fetchOverride || fetch);
      await secrets().setJSON("store-link", { refreshToken: r.refreshToken, email: r.email, by: email, at: (/* @__PURE__ */ new Date()).toISOString() });
      storeCache = null;
      return json(200, { ok: true, linked: true, email: r.email });
    }
    if (body.action === "store-read" || body.action === "store-add-customer") {
      const tenant = tenantId(body.tenant);
      if (!tenant) return json(400, { error: "tenant" });
      if (!await mayUseStore(email, tenant, String(body.idToken || ""))) return json(403, { error: "role" });
      const tok = await storeId();
      if (body.action === "store-read") return json(200, { ok: true, rows: await storeList(tok, tenant, String(body.name || ""), fetchOverride || fetch) });
      return json(200, { ok: true, id: await storeCreateCustomer(tok, tenant, body.customer || {}, fetchOverride || fetch) });
    }
    if (body.action === "sa") {
      if (!await ownsAny(email, String(body.idToken || ""))) return json(403, { error: "owners only" });
      let j;
      try {
        j = JSON.parse(String(body.json || ""));
      } catch {
        return json(400, { error: "not json" });
      }
      if (j.type !== "service_account" || !j.private_key || !j.client_email) return json(400, { error: "not a service account file" });
      if (j.project_id !== projectId()) return json(400, { error: `project ${j.project_id}, expected ${projectId()}` });
      await secrets().set("sa.json", JSON.stringify(j));
      adminCache = null;
      return json(200, { ok: true, project: j.project_id, account: j.client_email });
    }
    if (["pay-create", "pay-status", "zc-key", "up-key", "pay-confirm"].includes(body.action)) {
      const db = await adminDb();
      const bookId = String(body.book || "");
      const book = /^[\w-]{1,80}$/.test(bookId) ? await db.get(`books/${bookId}`) : null;
      if (!book) return json(404, { error: "no-book" });
      const role = roleIn(book, email);
      if (body.action === "pay-status") {
        if (!role) return json(403, { error: "role" });
        const uc = await upCredsOf(bookId);
        return json(200, { admin: true, zcredit: !!await zcKeyOf(bookId), upay: !!uc, upayEmail: uc ? uc.email : "", upayKey: !!(uc && uc.key), mail: mailReady() || !!mailOverride, sign: (await signState()).sign });
      }
      if (body.action === "zc-key") {
        if (role !== "owner") return json(403, { error: "owners only" });
        const key = String(body.key || "").trim();
        if (!key) {
          await secrets().delete("zc:" + bookId);
          return json(200, { ok: true, zcredit: false });
        }
        if (key.length < 8 || key.length > 300) return json(400, { error: "key" });
        await secrets().setJSON("zc:" + bookId, { key, by: email, at: (/* @__PURE__ */ new Date()).toISOString() });
        return json(200, { ok: true, zcredit: true });
      }
      if (body.action === "up-key") {
        if (role !== "owner") return json(403, { error: "owners only" });
        const em = String(body.email || "").trim().toLowerCase(), key = String(body.key || "").trim();
        if (!em && !key) {
          await secrets().delete("up:" + bookId);
          return json(200, { ok: true, upay: false });
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || key && (key.length < 6 || key.length > 300)) return json(400, { error: "key" });
        const old = key ? null : await secrets().get("up:" + bookId, { type: "json" }).catch(() => null);
        await secrets().setJSON("up:" + bookId, { email: em, key: key || old?.key || "", by: email, at: (/* @__PURE__ */ new Date()).toISOString() });
        return json(200, { ok: true, upay: true });
      }
      if (body.action === "pay-confirm") {
        /* The business saw the payment in uPay's own screen and confirms it:
           the same issuing as a confirmed payment, by the same path. */
        if (!["owner", "clerk"].includes(role)) return json(403, { error: "role" });
        const pid = String(body.pay || "");
        const pr = /^[\w-]{1,80}$/.test(pid) ? await db.get(`books/${bookId}/payreqs/${pid}`) : null;
        if (!pr) return json(404, { error: "no-page" });
        if (pr.status !== "open") return json(400, { error: "status" });
        let kept = await secrets().get(`pay:${bookId}:${pid}`).catch(() => null);
        if (!kept) { kept = token(24); await secrets().set(`pay:${bookId}:${pid}`, kept); }
        const r = await handleCallback({ bookId, payId: pid, secret: kept, body: { UniqueID: pid, ReferenceNumber: String(pr.upReport?.trx || body.ref || "manual"), Total: pr.total } }, {
          db, secretOf: (bb, pp) => secrets().get(`pay:${bb}:${pp}`).catch(() => null),
          pdf: (bk, d, o) => docPdf(bk, d, o), sign: (await signState()).sign ? (pdf, info) => signPdf(pdf, info) : null,
          mail: mailOverride || mailReady() ? sendMail : null, ita: null, version: VERSION
        });
        return json(r.status || 200, r);
      }
      if (!["owner", "clerk"].includes(role)) return json(403, { error: "role" });
      const provider = body.provider === "upay" ? "upay" : "zcredit";
      if (provider === "upay" ? !await upCredsOf(bookId) : !await zcKeyOf(bookId)) return json(400, { error: provider === "upay" ? "no-upay" : "no-zcredit" });
      const rate = payDocType(book) === "400" ? 0 : rateOf(book);
      const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 50).map((l) => ({ desc: String(l.desc || "").trim().slice(0, 200), qty: Number(l.qty) || 0, price: r2(l.price), ...l.itemId ? { itemId: String(l.itemId), sku: String(l.sku || "") } : {} })).filter((l) => l.desc && l.qty > 0 && l.price > 0);
      if (!lines.length) return json(400, { error: "lines" });
      const incl = rate ? !!body.incl : true;
      const tot = totals(lines, incl, rate);
      if (tot.total <= 0 || tot.total > 1e6) return json(400, { error: "total" });
      const c = body.customer || {};
      const customer = {
        name: String(c.name || "").trim().slice(0, 120),
        taxId: digitsOf(c.taxId).slice(0, 12),
        phone: String(c.phone || "").trim().slice(0, 30),
        email: String(c.email || "").trim().toLowerCase().slice(0, 120),
        address: String(c.address || "").trim().slice(0, 200)
      };
      if (!customer.name) return json(400, { error: "name" });
      const now = /* @__PURE__ */ new Date();
      const id = "pay_" + now.getTime().toString(36) + token(3);
      const linkKey = token(8);
      const link = `${baseOf(url)}/p/${bookId}/${id}/${linkKey}`;
      const rec = {
        id,
        status: "open",
        createdAt: now.toISOString(),
        createdBy: email,
        customer,
        lines,
        incl,
        vatRate: rate,
        net: tot.net,
        vat: tot.vat,
        total: tot.total,
        maxPayments: Math.max(1, Math.min(36, Number(body.maxPayments) || 1)),
        note: String(body.note || "").trim().slice(0, 200),
        title: String(body.title || lines[0].desc).slice(0, 100),
        linkKey,
        link,
        provider,
        docType: payDocType(book)
      };
      await db.set(`books/${bookId}/payreqs/${id}`, rec);
      await db.set(`books/${bookId}/log/log_${now.getTime().toString(36)}${token(2)}`, {
        at: now.toISOString(),
        user: email,
        action: "payreq",
        title: `\u05D3\u05E3 \u05E1\u05DC\u05D9\u05E7\u05D4 \xB7 ${customer.name} \xB7 \u20AA${tot.total}`,
        series: "test"
      }).catch(() => {
      });
      return json(200, { ok: true, id, link, payreq: rec });
    }
    if (body.action === "archive") {
      if (!mailReady()) return json(400, { error: "no-mail" });
      const files = (body.files || []).slice(0, 5).map((f) => ({
        filename: String(f.name || "file"),
        content: Buffer.from(String(f.b64 || ""), "base64"),
        contentType: String(f.type || "application/octet-stream")
      }));
      await mailer().sendMail({
        from: env("MAIL_FROM") || env("SMTP_USER"),
        to: email,
        subject: String(body.subject || "Tizon Books \xB7 \u05D0\u05E8\u05DB\u05D9\u05D5\u05DF \u05D7\u05D5\u05D3\u05E9\u05D9"),
        text: String(body.text || ""),
        attachments: files
      });
      return json(200, { ok: true, to: email });
    }
    if (body.action === "backup") {
      if (!mailReady()) return json(400, { error: "no-mail" });
      const data = String(body.data || "");
      if (!data || data.length > 20 * 1024 * 1024) return json(400, { error: "bad-backup" });
      await mailer().sendMail({
        from: env("MAIL_FROM") || env("SMTP_USER"),
        to: email,
        subject: `Tizon Books \xB7 \u05D2\u05D9\u05D1\u05D5\u05D9 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
        text: "\u05D2\u05D9\u05D1\u05D5\u05D9 \u05D0\u05D5\u05D8\u05D5\u05DE\u05D8\u05D9 \u05E9\u05DC \u05DB\u05DC \u05D4\u05E2\u05E1\u05E7\u05D9\u05DD. \u05DC\u05E9\u05D7\u05D6\u05D5\u05E8: \u05D2\u05D9\u05D1\u05D5\u05D9 \u05D5\u05E2\u05E0\u05DF \u2190 \u05E9\u05D7\u05D6\u05E8 \u05DE\u05D2\u05D9\u05D1\u05D5\u05D9.",
        attachments: [{ filename: String(body.filename || "tizon-books-backup.json"), content: Buffer.from(data, "utf8"), contentType: "application/json" }]
      });
      return json(200, { ok: true, to: email });
    }
    return json(400, { error: "action" });
  } catch (e) {
    return json(e.status || (String(e.code || "").startsWith("ERR_J") ? 401 : 500), { error: String(e.message || e) });
  }
};
export {
  __test,
  certInfo,
  books_mail_default as default,
  signPdf,
  /* For the scheduled reports (books-reports.mjs), which share these. */
  saJson,
  sendMail,
  mailReady,
  secrets,
  icountDocs,
  who
};
