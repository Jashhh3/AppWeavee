SHELL := /bin/sh
.PHONY: test build
test:
	npm ci --offline
	cd backend && npm ci --offline && npm test && npm run typecheck
	cd frontend && npm ci --offline && npm test
	cd sdk && npm ci --offline && npm run build
build:
	cd backend && npm run build
	cd frontend && npm run build
	cd sdk && npm run build
