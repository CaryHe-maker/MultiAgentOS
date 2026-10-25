# bookshelf

A small lending service for a neighbourhood library. Members borrow and return books over a
JSON HTTP API; overdue loans accrue a late fee, and members can queue holds on books that are
currently out.

```
npm install
npm test
npm start   # listens on PORT, default 8080
```

Configuration lives in `config/library.json`.
