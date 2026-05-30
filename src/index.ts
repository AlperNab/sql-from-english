#!/usr/bin/env node
/**
 * sql-from-english — natural language → production-ready SQL
 * Supports PostgreSQL, MySQL, SQLite, BigQuery, Snowflake
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const SYSTEM = `You are an expert SQL engineer. Convert natural language queries to production-ready SQL.

Rules:
- Output ONLY a JSON object, no markdown, no explanation
- Use best practices: proper JOINs, avoid SELECT *, use CTEs for complex queries
- Add inline SQL comments for non-obvious logic
- Warn about potential performance issues or missing indexes
- Flag any ambiguities in the natural language request

Response format:
{
  "sql": "-- SQL query here\\nSELECT ...",
  "dialect": "postgresql",
  "explanation": "Plain English explanation of what the query does",
  "warnings": ["potential N+1 if table is large", "..."],
  "suggested_indexes": ["CREATE INDEX idx_orders_user_id ON orders(user_id);"],
  "ambiguities": ["'recent' was interpreted as last 30 days — specify if different"],
  "confidence": 0.95
}`;

export interface SQLResult {
  sql: string; dialect: string; explanation: string;
  warnings: string[]; suggested_indexes: string[];
  ambiguities: string[]; confidence: number;
}

export interface SchemaContext {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; nullable?: boolean; is_pk?: boolean; is_fk?: string }>;
    description?: string;
  }>;
}

export class SQLFromEnglish {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
  }

  async convert(
    query: string,
    schema?: SchemaContext,
    dialect: string = "postgresql"
  ): Promise<SQLResult> {
    const schemaStr = schema ? this.formatSchema(schema) : "No schema provided — generate generic SQL";

    const resp = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Database dialect: ${dialect}\n\nSchema:\n${schemaStr}\n\nQuery: ${query}`,
      }],
    });

    const text = (resp.content[0] as any).text.trim()
      .replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");

    try { return JSON.parse(text); }
    catch { return { sql: text, dialect, explanation: "", warnings: [], suggested_indexes: [], ambiguities: [], confidence: 0.5 }; }
  }

  private formatSchema(schema: SchemaContext): string {
    return schema.tables.map(t => {
      const cols = t.columns.map(c =>
        `  ${c.name} ${c.type}${c.is_pk ? " PRIMARY KEY" : ""}${c.is_fk ? ` REFERENCES ${c.is_fk}` : ""}${c.nullable === false ? " NOT NULL" : ""}`
      ).join(",\n");
      return `CREATE TABLE ${t.name} (\n${cols}\n);${t.description ? ` -- ${t.description}` : ""}`;
    }).join("\n\n");
  }
}

// CLI
async function cli() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log("Usage: sql-from-english \"your query\" [--schema schema.json] [--dialect postgresql]");
    process.exit(0);
  }

  const query = args[0];
  const schemaIdx = args.indexOf("--schema");
  const dialectIdx = args.indexOf("--dialect");
  const jsonFlag = args.includes("--json");

  let schema: SchemaContext | undefined;
  if (schemaIdx >= 0 && args[schemaIdx + 1]) {
    const p = resolve(args[schemaIdx + 1]);
    if (existsSync(p)) schema = JSON.parse(readFileSync(p, "utf-8"));
  }

  const dialect = dialectIdx >= 0 ? args[dialectIdx + 1] : "postgresql";
  const converter = new SQLFromEnglish();
  const result = await converter.convert(query, schema, dialect);

  if (jsonFlag) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log("\n── Generated SQL ──────────────────────────────────");
  console.log(result.sql);
  console.log("\n── Explanation ────────────────────────────────────");
  console.log(result.explanation);
  if (result.warnings.length) { console.log("\n── Warnings ───────────────────────────────────────"); result.warnings.forEach(w => console.log(`  ⚠ ${w}`)); }
  if (result.suggested_indexes.length) { console.log("\n── Suggested indexes ──────────────────────────────"); result.suggested_indexes.forEach(i => console.log(`  ${i}`)); }
  if (result.ambiguities.length) { console.log("\n── Ambiguities resolved ───────────────────────────"); result.ambiguities.forEach(a => console.log(`  ? ${a}`)); }
  console.log(`\nConfidence: ${Math.round(result.confidence * 100)}%\n`);
}

cli().catch(console.error);
