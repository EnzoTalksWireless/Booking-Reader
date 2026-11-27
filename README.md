# OMF Booking Reader

A browser-based workspace for importing, reviewing, validating, analyzing, and exporting OMF booking orders. The app converts coded booking data into readable customer and product information using locally imported master CSV files.

**Live app:** https://omf-reader.vercel.app

## Features

- **Dashboard** — View booking totals, sales value, product lines, units, average booking value, and saved catalog counts.
- **Import booking files** — Load multiple `.omf` or `.txt` booking files into the current browser session.
- **Customer and product catalogs** — Import CSV master data to resolve customer and product codes into readable names and details.
- **Browse bookings** — Review one order at a time, navigate between invoices, filter by imported file or company, and optionally show bonus items only.
- **Bonus policies** — Create quantity-based bonus tiers, configure a separate FOC product when applicable, set effective dates, and import name-based bonus policies from CSV.
- **Sales analysis** — Review sales trends and summaries, including product and route analysis.
- **Validation** — Identify booking records whose customer or product codes do not match the imported master catalogs.
- **Excel export** — Download a workbook containing booking summary, booking details, customer summary, and product summary sheets.
- **Local storage management** — Review and clear saved master data or the current booking session.
- **Light and dark themes** — Switch the interface theme.

## Getting started

1. Open the [live app](https://omf-reader.vercel.app) in a modern browser.
2. Open **Import Files**.
3. Import your customer master CSV and product master CSV.
4. Import one or more OMF booking files.
5. Open **Browse Bookings** to review the decoded orders.
6. Add or import bonus policies if you want the app to calculate applicable bonus quantities.
7. Use **Validation**, **Sales Analysis**, and **Export Excel** to review and work with the imported data.

The app runs in the browser. There is no account sign-in or application server database to configure.

## Master CSV formats

CSV files should include a header row. Header names are expected to use the field names below.

### Products CSV

| Column | Purpose |
| --- | --- |
| `product_code` | Product code used in booking files |
| `product_name` | Readable product name |
| `packing` | Product packing description |
| `company` | Manufacturer or company |
| `category` | Product category |
| `trade_price` | Trade price |

### Customers CSV

| Column | Purpose |
| --- | --- |
| `customer_code` | Customer code used in booking files |
| `customer_name` | Readable customer or outlet name |
| `address` | Customer address |
| `city` | Customer city |
| `phone` | Contact number |

Keep product and customer codes consistent with the codes contained in your OMF booking files. The reader normalizes leading zeroes when matching product codes.

## Bonus policy CSV

Bonus policies can be imported using readable product names instead of requiring you to remember product codes.

The CSV must contain these columns:

| Column | Purpose |
| --- | --- |
| `Start Date` | Date from which the policy applies |
| `End Date` | Last date on which the policy applies |
| `Item Name` | Product name; matched against the imported Products catalog |
| `Target` | Required sale quantity |
| `Bonus` | Free bonus quantity |
| `Policy Type` | Use `Bonus` for bonus policies |
| `Scheme Type` | Use `Item Policy` for supported item bonus rows |

Example:

```csv
Start Date,End Date,Item Name,Target,Bonus,Policy Type,Scheme Type
01-11-2026,30-11-2026,Example Product 100mg,13,1,Bonus,Item Policy
01-11-2026,30-11-2026,Example Syrup 120ml,50,4,Bonus,Item Policy
```

- Dates may use `DD-MM-YYYY` or `YYYY-MM-DD`; blank dates mean no date limit.
- Item names must match a product in the imported product catalog. The import preview flags missing or ambiguous matches for review.
- Only rows with `Policy Type = Bonus` and `Scheme Type = Item Policy` are imported. Discount rows are ignored.
- Review the preview and select **Apply Bonus Policies** to save valid rows. Importing a CSV does not immediately change saved policies.
- The app also provides a downloadable CSV template and format guide in the Bonus Policies section.

## Data storage and privacy

The app is designed to process data locally in your browser:

- Imported booking files and their decoded booking records are kept in **session storage**. They are cleared when the browser tab/session is closed.
- Product catalogs, customer catalogs, and bonus policies are saved in **IndexedDB** in the browser and remain available across refreshes until cleared.
- The selected light/dark theme is saved in browser local storage.
- There is no application backend database or automatic cloud synchronization.

**Important:** Browser storage is tied to the browser and device being used. Clearing browser site data, using a different browser/device, or browser storage restrictions can remove or prevent access to saved data. Export important reports and keep secure backups of your original source files. Do not use a shared or public computer for confidential booking or customer information.

Use the **Storage** section to manage saved data. The app provides separate actions for clearing the current booking session and clearing saved master data.

## Technology

- HTML, CSS, and vanilla JavaScript
- IndexedDB, session storage, and local storage
- [Chart.js](https://www.chartjs.org/) for charts
- [SheetJS (xlsx)](https://sheetjs.com/) for Excel export
- [Lucide](https://lucide.dev/) icons

The application loads its front-end libraries from public CDNs, so an internet connection is required for those library assets.

## Running locally

Because this is a static browser application, you can serve the repository with any simple static web server.

For example, with Python installed:

```bash
python -m http.server 8000
```

Then open:

```
http://localhost:8000
```

You can also deploy the static project to a hosting provider such as Vercel or GitHub Pages. No build step or package installation is required for the current front-end.

## Notes

- The accuracy of decoded names and bonus calculations depends on the correctness and completeness of the imported master CSV files and bonus policies.
- Keep the original OMF and CSV source files unchanged as your source of record.
- This README describes the current browser application; it does not imply that data is uploaded to or backed up by a server.

## Repository

[EnzoTalksWireless/Booking-Reader](https://github.com/EnzoTalksWireless/Booking-Reader)
