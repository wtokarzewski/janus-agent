---
name: allegro-shopper
description: "Product search and price comparison on Allegro.pl. Use when user asks to find, compare, or check prices of products on Allegro."
version: "0.1.0"
always: false
---

# Allegro Shopper

Search for products and compare prices on Allegro.pl using the browser operator.

## When to use

- User asks to find a product on Allegro
- Price comparison or cheapest offer lookup
- "Ile kosztuje...", "Znajdz na Allegro...", "Porownaj ceny..."
- Any Polish marketplace shopping request

## Before searching — clarify the product

Always ask for specifics before searching. A vague query wastes browser actions.

Clarify:
- **Exact product name** (brand, model, variant)
- **Size/weight** (1kg, 500g, 250ml)
- **Quantity** (1 pack, multipack)
- **Delivery preference** (Allegro Smart? any delivery?)
- **Price range** (if budget is limited)

Example: "kawa" is too vague. "Dallmayr Home Barista Caffe Crema Dolce 1kg ziarnista" is actionable.

## Allegro URL structure

Build filtered URLs directly — don't navigate to allegro.pl and click through the UI.

Base: `https://allegro.pl/listing?string={query}`

### Query parameters

| Param | Values | Description |
|-------|--------|-------------|
| `string` | URL-encoded query | Search terms |
| `order` | `p` (cheapest), `d` (most expensive), `m` (relevance), `qd` (newest) | Sort order |
| `smart` | `1` | Allegro Smart only |
| `buyNow` | `1` | Kup Teraz (buy now, skip auctions) |

### Example URLs

```
# Cheapest, Smart delivery, buy-now only
https://allegro.pl/listing?string=dallmayr+crema+dolce+1kg&order=p&smart=1&buyNow=1

# Relevance sort (default)
https://allegro.pl/listing?string=lavazza+crema+e+gusto+1kg

# Newest listings
https://allegro.pl/listing?string=iphone+15+pro&order=qd
```

## Workflow

```
# 1. Build URL with filters
#    Encode query, add order=p&smart=1&buyNow=1 for typical shopping

# 2. Navigate
browser({ command: "navigate", args: { url: "<built URL>" } })
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 1500 } })

# 3. Dismiss cookie banner (first visit only)
browser({ command: "dismissCookies" })
browser({ command: "waitFor", args: { type: "domStable", stableForMs: 500 } })

# 4. Snapshot and extract
browser({ command: "snapshot" })
# Look for elements with semanticHints: ["product_price", "product_title"]
# Extract: title, price, delivery info

# 5. If results look wrong — scroll down for more
browser({ command: "scroll", args: { deltaY: 800 } })
browser({ command: "snapshot" })
```

## Reading search results

In the snapshot, look for:
- **`product_title`** hint — product name links
- **`product_price`** hint — price elements (format: "XX,XX zl")
- Elements with `href` containing `/oferta/` — these are product links

Group consecutive title + price elements — they belong to the same listing.

## Output format

Present results as a table:

```
| # | Produkt | Cena | Smart | Link |
|---|---------|------|-------|------|
| 1 | [name]  | X zl | tak   | [url] |
| 2 | [name]  | X zl | tak   | [url] |
| 3 | [name]  | X zl | nie   | [url] |
```

Always include:
- Top 3-5 cheapest matching offers
- Whether Allegro Smart delivery is available
- Direct link to the offer

## Rules

1. **Always clarify the product first.** Don't search for vague terms.
2. **Build URL with filters directly.** Don't click through UI to set filters — use URL params.
3. **dismissCookies on first visit.** Allegro shows a GDPR banner on first load.
4. **Don't try to buy.** Policy blocks checkout/payment actions. Give the user a link.
5. **Verify results match the query.** Allegro sometimes returns loosely related products — check titles.
6. **If no results or wrong products — refine the query.** Try shorter/different terms.
7. **One snapshot is usually enough.** Allegro loads results in a single page. Scroll only if needed.
8. **Prefer `buyNow=1`.** Skip auctions unless the user specifically wants them.
