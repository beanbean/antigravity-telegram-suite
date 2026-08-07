const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

class HotBrainAdapter {
  constructor(options = {}) {
    this.workdir = options.workdir || process.env.HOTBRAIN_WORKDIR || path.join(os.homedir(), '.nexmeos-supabase');
    this.timeoutMs = options.timeoutMs || Number(process.env.DAILY_LOOP_DB_TIMEOUT_MS || 15000);
    this.run = options.run || this._run.bind(this);
  }

  _run(sql) {
    return new Promise((resolve, reject) => {
      const child = spawn('supabase', ['db', 'query', '--linked', '--output-format', 'json', '--file', '/dev/stdin'], {
        cwd: this.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), this.timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) return reject(new Error('Hot Brain query timed out'));
        if (code !== 0) {
          let detail = stderr.trim();
          try {
            const payload = stdout.trim() ? JSON.parse(stdout.trim()) : null;
            const msg = payload?.error?.message || payload?.message;
            if (msg) detail = msg;
          } catch {
            // keep stderr
          }
          return reject(new Error(`Hot Brain query failed: ${detail.slice(0, 500)}`));
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : []);
        } catch {
          reject(new Error('Hot Brain returned invalid JSON'));
        }
      });
      child.stdin.end(sql);
    });
  }

  query(sql, params = []) {
    if (!Array.isArray(params)) throw new TypeError('params must be an array');
    let index = 0;
    const rendered = sql.replace(/\?/g, () => {
      if (index >= params.length) throw new Error('Missing SQL parameter');
      const value = params[index++];
      if (value === null || value === undefined) return 'NULL';
      return `'${String(value).replace(/\0/g, '').replace(/'/g, "''")}'`;
    });
    if (index !== params.length) throw new Error('Unused SQL parameter');
    return this.run(rendered);
  }

  async safeQuery(sql, params = []) {
    try {
      return { ok: true, rows: await this.query(sql, params) };
    } catch (error) {
      console.error('[DailyLoop] Hot Brain unavailable:', error.message);
      return { ok: false, rows: [], error: error.message };
    }
  }
}

module.exports = { HotBrainAdapter };
