/**
 * Drop-in sqlite3 API adapter using sql.js (pure WebAssembly, no native compilation).
 * Supports: db.run(), db.get(), db.all(), db.serialize(), db.close()
 */
const fs = require("fs");

let SQL = null;

async function getSql() {
  if (!SQL) {
    const initSqlJs = require("sql.js");
    SQL = await initSqlJs();
  }
  return SQL;
}

function selectRows(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

class Database {
  constructor(dbPath, callback) {
    this.dbPath = dbPath;
    this._db = null;
    this._ready = false;
    this._queue = [];

    getSql()
      .then((SQL) => {
        if (fs.existsSync(dbPath)) {
          const fileBuffer = fs.readFileSync(dbPath);
          this._db = new SQL.Database(fileBuffer);
        } else {
          this._db = new SQL.Database();
        }
        this._ready = true;
        const q = this._queue.slice();
        this._queue = [];
        q.forEach((fn) => fn());
        if (callback) callback(null);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
  }

  _save() {
    if (!this._db) return;
    const data = this._db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  _enqueue(fn) {
    if (this._ready) {
      fn();
    } else {
      this._queue.push(fn);
    }
  }

  run(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    params = params || [];
    this._enqueue(() => {
      try {
        this._db.run(sql, params);
        this._save();
        const lastIDRows = selectRows(
          this._db,
          "SELECT last_insert_rowid() as id",
          [],
        );
        const changesRows = selectRows(this._db, "SELECT changes() as c", []);
        const lastID = lastIDRows.length ? lastIDRows[0].id : null;
        const changes = changesRows.length ? changesRows[0].c : 0;
        if (callback) callback.call({ lastID, changes }, null);
      } catch (e) {
        if (callback) callback(e);
      }
    });
  }

  get(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    params = params || [];
    this._enqueue(() => {
      try {
        const rows = selectRows(this._db, sql, params);
        if (callback) callback(null, rows.length ? rows[0] : undefined);
      } catch (e) {
        if (callback) callback(e);
      }
    });
  }

  all(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    params = params || [];
    this._enqueue(() => {
      try {
        const rows = selectRows(this._db, sql, params);
        if (callback) callback(null, rows);
      } catch (e) {
        if (callback) callback(e);
      }
    });
  }

  serialize(callback) {
    this._enqueue(() => {
      if (callback) callback();
    });
  }

  close(callback) {
    this._enqueue(() => {
      if (this._db) {
        this._save();
        this._db.close();
        this._db = null;
      }
      if (callback) callback(null);
    });
  }
}

module.exports = {
  verbose: () => module.exports,
  Database,
  OPEN_READWRITE: 2,
  OPEN_CREATE: 4,
  OPEN_READONLY: 1,
};
