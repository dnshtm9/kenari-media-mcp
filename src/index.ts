#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

export function createAppServer() {
  return createServer();
}

export function createServerFactory() {
  return () => createServer();
}

void serveStdio(createServerFactory());
