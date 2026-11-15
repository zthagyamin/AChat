# Third-Party Open-Source Notices (AChat v2.0.0 Fusion Edition)

AChat (`agent-wechat`) incorporates clean-room architectural patterns and adapted open-source concepts from the following permissive open-source projects. No proprietary or source-available `enterprise/` code is included.

---

## 1. T3 Code (`pingdotgg/t3code`)
- **Repository**: https://github.com/pingdotgg/t3code
- **License**: MIT License
- **Adapted Capabilities**:
  - Multi-CLI provider detection & unified control surface concepts (`codex`, `agy`, `claude`, `opencode`, `ollama`).
  - One-click Git staging/commit & isolated `git worktree` workspace management workflow.
  - Tailscale `status --json` MagicDNS / `100.x` endpoint discovery and secret-redacting diagnostic sanitization (`tskey-*` redaction).

### MIT License

Copyright (c) Theo Browne and T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 2. OpenMausBot — Open-Source Edition (`milind-soni/OpenMausBot`)
- **Repository**: https://github.com/milind-soni/OpenMausBot
- **License**: Apache License, Version 2.0 (strictly outside `enterprise/`; zero `enterprise/` files accessed or used)
- **Adapted Capabilities**:
  - Inline chat approval cards (`Allow / Deny` write-permission & action confirmation) with single-settlement double-submit refusal guards.
  - Inline structured & `A/B/C` option selection cards (`options-card` bounds & settlement receipts).
  - Per-agent employee profile configuration (custom model & role persona directives) and live host Computer Panel preview concept.

### Apache License, Version 2.0

Copyright (c) Milind Soni and OpenMausBot Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these components except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
