SHELL := /bin/sh
.PHONY: test build
test:
	cd backend && npm ci --offline && npm test && npm run typecheck
	cd frontend && npm ci --offline && npm test
build:
	cd backend && npm run build
	cd frontend && npm run build
