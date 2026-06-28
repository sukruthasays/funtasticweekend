# Funtastic Weekend

A Bay Area family events aggregator. Scrapes 6 sources every 6 hours and displays upcoming kids & family events filterable by date, region, and source.

## Sources

| Source | Region coverage |
|---|---|
| [Ronnie's Awesome List](https://www.ronniesawesomelist.com/) | Bay Area wide |
| [Marin Mommies](https://www.marinmommies.com/calendar) | North Bay |
| [SF Funcheap](https://sf.funcheap.com/category/event/event-types/kids-families/) | SF + Bay Area |
| [510 Families](https://www.510families.com/calendar/) | East Bay |
| [SFPL Kids Events](https://sfpl.org/kids/events/calendar/) | San Francisco |
| [DSE Runners](https://dserunners.com/race-schedule/) | San Francisco (5K + Kids runs) |

## Features

- Filter events by date, region (SF, North Bay, East Bay, Peninsula, South Bay), and source
- "Next day" button to step forward from any date
- Add any event by pasting its URL — the server scrapes the page automatically
- Google Calendar button on each event card
- Scraping runs every 6 hours in the background

## Stack

- **Backend:** Node.js + Express
- **Scraping:** axios + cheerio
- **Database:** PostgreSQL
- **Scheduling:** node-cron
- **Frontend:** Vanilla HTML/CSS/JS (no framework)

## Running locally

**Prerequisites:** Node.js 18+, PostgreSQL running locally

```bash
# Install dependencies
npm install

# Create the database
psql postgres -c "CREATE DATABASE funtasticweekend;"
psql funtasticweekend < schema.sql

# Start the server (scrapes on startup, then every 6 hours)
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | local `funtasticweekend` db |
| `PORT` | Port to listen on | `3000` |
