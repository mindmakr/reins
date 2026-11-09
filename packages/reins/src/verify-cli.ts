#!/usr/bin/env node
import { main } from './verify.js';

process.exitCode = main(process.argv.slice(2));
