.PHONY: install dev dev-offline test typecheck deploy bootstrap provision mcp-install mcp-test mcp-http injector-deploy

install:            ## Install Worker + MCP dependencies
	cd worker && npm install
	cd mcp && python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"

dev:                ## Worker dev server with real Cloudflare bindings (needs wrangler login)
	cd worker && npm run db:migrate:local && npm run dev

dev-offline:        ## Worker dev server without Workers AI / Vectorize (no login needed)
	cd worker && npm run dev:offline

typecheck:
	cd worker && npm run typecheck

test:               ## All tests
	cd worker && npm test
	cd mcp && . .venv/bin/activate && pytest -q

deploy:
	cd worker && npm run db:migrate && npm run deploy

bootstrap:          ## First-time Cloudflare setup + deploy
	./scripts/bootstrap.sh

provision:          ## Create the chatbots for the sites in sites/*.json
	python3 scripts/provision.py

mcp-http:           ## Run the MCP server over HTTP locally on :8090
	cd mcp && . .venv/bin/activate && awebchatbot-mcp --http --port 8090

injector-deploy:    ## Deploy the zero-code injector for one site: make injector-deploy SITE=robomodal
	cd integrations/cloudflare-injector && npm install && npx wrangler deploy --env $(SITE)
