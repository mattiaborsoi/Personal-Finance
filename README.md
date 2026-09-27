# Settl

**Shared money, settled by AI.**

Settl reads your bank statements, works out what's shared and tells the two of you
who owes whom: one figure, once a month, on a machine you own.

It is for two people who share a flat, the bills, the weekly shop and the odd holiday,
each with their own accounts and cards, who would rather not keep a spreadsheet.

<p align="center"><img src="docs/images/settlement.png" width="900" alt="The settlement banner for one month: Sam owes Alex £161.78, settle by 1 September, split 55.6% / 44.4%, with the four sums behind the figure"></p>

## Why you'll like it

* **Drop in a statement, get a sorted month.** A PDF, CSV or spreadsheet from any bank
  or card. Every line gets a merchant, a category and a "shared or not"; you only
  approve the few Settl isn't sure about.
* **It learns your merchants.** Approve Waitrose once and every Waitrose after that is
  filed for you. The more you use it, the less it asks.
* **Split the tricky ones.** £10 at Marks & Spencer becomes £6 groceries shared by
  income and £4 for a personal item, in one dialog.
* **One figure, settled.** Your partner logs the cash they paid from their phone, card
  payments and transfers cancel themselves out, and at month end Settl shows who owes
  whom, by when, with every line behind it.
* **Looks after itself.** The two of you, your accounts and cards, your categories,
  your rules and which AI model does what (or a LiteLLM you already run) are all set
  up in Settings, not in a config file, and Settl updates itself from GitHub with one
  click.

## See it

![The dashboard for one month: household burn, the trend over recent months and spend by category](docs/images/dashboard.png)
*The month at a glance: what the household spent, how it compares with recent months,
and where it went. Two more views show your own true share and your cash flow.*

![The sign-in screen, with one password field](docs/images/login.png)
*One password each: yours opens everything, your partner's opens the claim form and
the month's figure.*

![The approval queue, with a merchant, a category and a claim type suggested for each line](docs/images/queue.png)
*The queue: the Starbucks, the TfL fares and the Netflix are already filed; you glance,
fix the odd one and approve the rest in one go.*

![The split dialog, dividing a Marks & Spencer receipt into two parts](docs/images/split.png)
*£10 at Marks & Spencer: £6 groceries shared by income, £4 personal.*

![The transactions list, showing a split transaction with its parts underneath](docs/images/transactions.png)
*The same receipt in the list with its parts underneath, alongside the month's Hilton
stay and British Airways flight on the Amex Platinum.*

![The partner's claim form on a phone](docs/images/claim-mobile.png)
*Your partner's phone: the Uber they paid for, logged in three taps and shared the way
they choose.*

![Settings: the list of accounts and cards, with add, edit and archive](docs/images/settings.png)
*Settings: your accounts and cards live here, not in a config file, and the System tab
updates Settl from GitHub with one click.*

## Run it in five minutes

You need a machine with Docker that stays on; a Mac mini or a NAS is ideal.

```bash
git clone https://github.com/mattiaborsoi/personal-finance settl && cd settl
cp .env.example .env     # then open .env and set the passwords and keys
docker compose up -d --build
```

The app refuses to start with the placeholder passwords, so do edit `.env` before
the last command. Open http://localhost, sign in with `PRIMARY_PASSWORD`, and set up
the two of you, your accounts and your categories under Settings; your partner opens
http://localhost/claim with `SECONDARY_PASSWORD`. Prefer a file? Copy
`config.example.yaml` to `config.yaml` before the first start and it seeds those
defaults; whatever you change in Settings afterwards wins.

It works with no AI key at all: set `LLM_PROVIDER=none` and `EMBEDDING_PROVIDER=hash`
in `.env` and Settl runs on your rules and the merchants it has already learned.

Everything else — updating, backups, running without an LLM, what goes where — is in
[docs/TECHNICAL.md](docs/TECHNICAL.md).

## Under the bonnet

Five containers on one box: the web front, the app, a database that doubles as the
merchant memory, a small proxy to whichever AI provider you choose (or none, if you
already run one), and an updater that pulls new versions. How they fit together, the
settlement maths and the security model are in [docs/TECHNICAL.md](docs/TECHNICAL.md).

**Private by design.** Settl runs on your machine and your statement files never leave
it. What goes out: short merchant lines for the AI to categorise, the page text of a
PDF only when the built-in parsers cannot read it, and one request to GitHub to check
for updates. Each of those can be switched off in Settings or `.env`.

* [docs/TECHNICAL.md](docs/TECHNICAL.md): architecture, deployment, the maths,
  configuration, schema and development setup.
* [docs/API.md](docs/API.md): the REST contract.
* [docs/BLUEPRINT.md](docs/BLUEPRINT.md): the original specification.

## Contributing

Bug reports and ideas go in [issues](https://github.com/mattiaborsoi/Personal-Finance/issues);
changes come as pull requests against `main`, see [CONTRIBUTING.md](CONTRIBUTING.md).
Security problems: [SECURITY.md](SECURITY.md). Settl is released under the
[MIT licence](LICENSE).
