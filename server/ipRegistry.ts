// Persistent domain -> address assignments for generated domains, stored as CSV (domain,ipv4,ipv6).
// Every domain gets its own addresses; rows can be edited by hand to pin specific values.
// An empty ipv6 column means the domain has no AAAA record.
import fs from "node:fs";
import path from "node:path";

export interface Assignment {
  ipv4: string;
  ipv6?: string;
}

const HEADER = "domain,ipv4,ipv6";
// Hosts .100-.254 of 203.0.113.0/24 (the hand-written zones use lower hosts), then 198.18.0.0/15.
const DOC_HOSTS = 155;
const BENCH_BASE = ((198 << 24) | (18 << 16)) >>> 0;

const ipv4At = (i: number) => {
  if (i < DOC_HOSTS) return `203.0.113.${100 + i}`;
  const n = BENCH_BASE + (i - DOC_HOSTS + 1);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
};
const ipv6At = (i: number) => `2001:db8:a::${(i + 1).toString(16)}`;

class IpRegistry {
  private rows: Map<string, Assignment> | null = null;
  private used = new Set<string>();
  private next = 0;

  private file = "";
  private writable = true; // false after the first failed write (e.g. read-only serverless filesystem)
  // Caps how many generated names are stored, so public traffic cannot grow the CSV or memory forever.
  private maxRows = Math.max(0, Number(process.env.DNS_SIM_MAX_DOMAINS) || 20000);

  private persist(fn: () => void) {
    if (!this.writable) return;
    try {
      fn();
    } catch (err) {
      this.writable = false;
      console.warn(`[dns-tcp] could not write ${this.file}: ${(err as Error).message} (continuing in memory)`);
    }
  }

  private load() {
    if (this.rows) return this.rows;
    this.file = path.resolve(process.env.DNS_SIM_CSV ?? "data/sim-domains.csv");
    this.rows = new Map();
    if (fs.existsSync(this.file)) {
      const text = fs.readFileSync(this.file, "utf8");
      if (text && !text.endsWith("\n")) this.persist(() => fs.appendFileSync(this.file, "\n")); // hand-edited file without a final newline
      for (const line of text.split(/\r?\n/).slice(1)) {
        const [domain, ipv4, ipv6] = line.split(",").map((s) => s?.trim());
        if (!domain || !ipv4) continue;
        this.rows.set(domain.toLowerCase(), { ipv4, ipv6: ipv6 || undefined });
        this.used.add(ipv4);
        if (ipv6) this.used.add(ipv6);
      }
    } else {
      this.persist(() => {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, HEADER + "\n");
      });
    }
    return this.rows;
  }

  get(domain: string): Assignment {
    const rows = this.load();
    const existing = rows.get(domain);
    if (existing) return existing;
    while (this.used.has(ipv4At(this.next)) || this.used.has(ipv6At(this.next))) this.next++;
    const a = { ipv4: ipv4At(this.next), ipv6: ipv6At(this.next) };
    if (rows.size >= this.maxRows) return a; // registry full: still answer, but do not remember the name
    this.next++;
    rows.set(domain, a);
    this.used.add(a.ipv4).add(a.ipv6);
    this.persist(() => fs.appendFileSync(this.file, `${domain},${a.ipv4},${a.ipv6}\n`));
    return a;
  }
}

export const ipRegistry = new IpRegistry();
