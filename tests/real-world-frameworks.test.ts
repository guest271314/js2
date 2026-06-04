import { describe, it } from "vitest";
import { compileValid } from "./real-world-helpers.js";

/**
 * Real-world frameworks: Hono, React, Express.
 *
 * test262 is pure ECMAScript conformance — it has no notion of a web
 * framework. These lock in that idiomatic framework source (routing,
 * middleware, hooks, request/response handlers) flows through the import
 * resolver's host-stub path and still compiles to a valid Wasm module. The
 * framework packages are not bundled; their symbols become host imports.
 */
describe("real-world: Hono (edge web framework)", () => {
  it("compiles routing, params, and json/text responses", async () => {
    await compileValid(`
      import { Hono } from "hono";
      const app = new Hono();
      app.get("/", (c: any) => c.text("Hello Hono!"));
      app.get("/users/:id", (c: any) => c.json({ id: c.req.param("id") }));
      app.post("/users", async (c: any) => {
        const body = await c.req.json();
        return c.json({ created: true, name: body.name }, 201);
      });
      export default app;
    `);
  });

  it("compiles middleware (app.use) with a next() chain", async () => {
    await compileValid(`
      import { Hono } from "hono";
      const app = new Hono();
      app.use("*", async (c: any, next: any) => {
        const start = Date.now();
        await next();
        c.header("X-Response-Time", String(Date.now() - start));
      });
      app.get("/health", (c: any) => c.json({ ok: true }));
      export default app;
    `);
  });
});

describe("real-world: React (hooks + components)", () => {
  it("compiles a function component using useState", async () => {
    await compileValid(`
      import { useState } from "react";
      export function Counter(initial: number): number {
        const [count, setCount] = useState(initial);
        setCount(count + 1);
        return count;
      }
    `);
  });

  it("compiles a custom hook using useState + useEffect", async () => {
    await compileValid(`
      import { useState, useEffect } from "react";
      export function useTick(start: number): number {
        const [tick, setTick] = useState(start);
        useEffect(() => {
          setTick(tick + 1);
        }, []);
        return tick;
      }
    `);
  });
});

describe("real-world: Express (Node web framework)", () => {
  it("compiles routing with req/res handlers", async () => {
    await compileValid(`
      import express from "express";
      const app = express();
      app.get("/", (req: any, res: any) => {
        res.send("Hello World");
      });
      app.get("/users/:id", (req: any, res: any) => {
        res.status(200).json({ id: req.params.id });
      });
      app.listen(3000);
      export function port(): number {
        return 3000;
      }
    `);
  });

  it("compiles app.use() middleware", async () => {
    await compileValid(`
      import express from "express";
      const app = express();
      app.use((req: any, res: any, next: any) => {
        next();
      });
      app.post("/echo", (req: any, res: any) => {
        res.json({ received: true });
      });
      export function ready(): number {
        return 1;
      }
    `);
  });
});
