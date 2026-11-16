// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outgoing attachment limits shared by the compose UI and the MCP send tools.
 *
 * Attachments travel as base64 inline in the send payload. The 18MB total
 * cap keeps the base64-inflated payload (~+33%) under the 25MB email size
 * limit enforced on receive.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
