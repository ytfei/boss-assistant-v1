# Boss 求职助手 · 开源版 —— 开发与发布辅助
#
# 常用命令：
#   make help             查看全部目标
#   make test             跑纯函数自测
#   make package          本地打出可加载的扩展 zip
#   make version          显示当前版本
#   make release v0.0.3   发版：改版本号 → 提交 → 打 tag → 推送（触发 CI 发布）

SHELL := /bin/bash
.DEFAULT_GOAL := help

MANIFEST := manifest.json
PKG      := package.json
ZIP      := boss-assistant.zip

.PHONY: help test package version clean release FORCE

# ------------------------------------------------------------------ 帮助
help:
	@echo "Boss 求职助手 · 开源版"
	@echo
	@echo "  make test              跑纯函数自测（node tests/run.js）"
	@echo "  make package           本地打出可加载的扩展 zip"
	@echo "  make version           显示当前版本"
	@echo "  make release v0.0.3    发版：改版本号 + 提交 + 打 tag + 推送"
	@echo "  make clean             清理本地打包产物"

# ------------------------------------------------------------------ 开发
test:
	@node tests/run.js

version:
	@node -p "require('./$(MANIFEST)').version"

package:
	@rm -f $(ZIP)
	@zip -r $(ZIP) $(MANIFEST) src LICENSE >/dev/null
	@echo "已生成 $(ZIP)"

clean:
	@rm -f $(ZIP)
	@echo "已清理 $(ZIP)"

# ------------------------------------------------------------------ 发版
# `make release v0.0.3` 里的 v0.0.3 会被 Make 当作**目标**，
# 由下面的模式规则 v% 接住并执行；release 只负责参数校验。
#
# 注意：不能把 v0.0.3 加进 .PHONY —— GNU Make 对 .PHONY 目标会跳过隐式规则搜索，
# 模式规则就再也匹配不上了。这里改用 FORCE 惯用法保证每次都会执行。
release:
ifeq ($(filter v%,$(MAKECMDGOALS)),)
	@echo "用法: make release v0.0.3   （版本号需带 v 前缀）"
	@exit 1
else
	@:
endif

FORCE:

# 捕获 `make release v0.0.3` / `make v0.0.3`，目标名即标签名
v%: FORCE
	@set -e; \
	TAG="$@"; \
	VER="$${TAG#v}"; \
	BRANCH="$$(git rev-parse --abbrev-ref HEAD)"; \
	echo "▶ 发版 $${TAG}（分支 $${BRANCH}）"; \
	\
	echo "$$VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$$' || { \
		echo "✗ 版本号格式不正确：$${VER}（应形如 0.0.3）"; exit 1; }; \
	\
	git diff --quiet && git diff --cached --quiet || { \
		echo "✗ 工作区有未提交改动，请先提交或 stash 后再发版"; exit 1; }; \
	\
	if git rev-parse -q --verify "refs/tags/$$TAG" >/dev/null; then \
		echo "✗ 本地已存在标签 $$TAG"; exit 1; fi; \
	if git ls-remote --tags origin "refs/tags/$$TAG" 2>/dev/null | grep -q .; then \
		echo "✗ 远程已存在标签 $$TAG"; exit 1; fi; \
	\
	echo "▶ 运行自测…"; \
	node tests/run.js >/dev/null; \
	echo "✓ 自测通过"; \
	\
	node -e "const fs=require('fs');const f='$(MANIFEST)';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='$$VER';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"; \
	node -e "const fs=require('fs');const f='$(PKG)';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='$$VER';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"; \
	echo "▶ 版本号已更新：$(MANIFEST)、$(PKG) → $$VER"; \
	\
	git add $(MANIFEST) $(PKG); \
	git commit -q -m "chore(release): $$TAG"; \
	git tag -a "$$TAG" -m "Release $$TAG"; \
	echo "▶ 已提交并打上标签 $$TAG"; \
	\
	git push origin "$$BRANCH"; \
	git push origin "$$TAG"; \
	echo "✓ 已推送 $$BRANCH 与 $$TAG"; \
	echo "  CI 将自动发布 GitHub Packages 与 Release，请到 Actions 页面查看"
