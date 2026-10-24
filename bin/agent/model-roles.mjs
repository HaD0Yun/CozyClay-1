// --- model roles (#717) ------------------------------------------------------
//
// One picked model (main) implies the rest of the lineup a turn may lean on: a
// cheap helper, a mid-tier advisor, a model that can see images, and the
// ordered alternatives to try when main fails. Subscription accounts usually
// have exactly one signed-in provider, so every derived role stays on main's
// provider; only the fallback chain may cross to another signed-in provider
// that serves the very same model id. Both functions are pure over a
// listAgentModels-shaped `{ providers }` catalog and never throw.

export const MODEL_ROLES = ["main", "helper", "vision", "advisor"];

const CLAUDE_TIERS = ["opus", "sonnet", "haiku"];
const GPT_MINI_CLASS = /mini|nano/;
const newestFirst = (a, b) => b.id.localeCompare(a.id, undefined, { numeric: true });

function splitModelKey(key) {
	const slash = typeof key === "string" ? key.indexOf("/") : -1;
	return slash > 0 ? { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) } : null;
}

const modelFamily = (id) => /^claude-/.test(id) ? "claude" : /^gpt-/.test(id) ? "gpt" : null;
const claudeTier = (id) => CLAUDE_TIERS.find((tier) => id.startsWith(`claude-${tier}`)) ?? null;
const takesImages = (model) => Array.isArray(model?.input) && model.input.includes("image");
const modelKeyOf = (providerId, model) => model.key ?? `${providerId}/${model.id}`;

/** main's provider entry, main's own model entry and the same-family models on that provider. */
function locateMain(mainKey, catalog) {
	const parts = splitModelKey(mainKey);
	const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
	const provider = parts && providers.find((entry) => entry?.id === parts.providerId);
	const models = Array.isArray(provider?.models) ? provider.models.filter((model) => typeof model?.id === "string") : [];
	const main = parts && models.find((model) => model.id === parts.modelId);
	if (!main) return null;
	const family = modelFamily(main.id);
	return { providers, provider, models, main, family, sameFamily: family ? models.filter((model) => modelFamily(model.id) === family) : [] };
}

/** The first preference that matches a model: an exact id, or the newest id a pattern matches. */
function pickModel(models, preferences) {
	for (const preference of preferences) {
		const match = typeof preference === "string"
			? models.find((model) => model.id === preference)
			: [...models].filter((model) => preference.test(model.id)).sort(newestFirst)[0];
		if (match) return match;
	}
	return null;
}

/** One tier of a Claude lineup, preferring main's own version (opus-5-5 -> sonnet-5-5). */
function claudeTierModel(models, mainId, tier) {
	const current = claudeTier(mainId);
	return pickModel(models, [current ? mainId.replace(`claude-${current}`, `claude-${tier}`) : null, new RegExp(`^claude-${tier}`)].filter(Boolean));
}

export function resolveRoleModels(mainKey, catalog) {
	const main = typeof mainKey === "string" ? mainKey : "";
	const found = locateMain(main, catalog);
	if (!found) return { main, helper: main, vision: main, advisor: main };
	const { provider, models, main: model, family, sameFamily } = found;
	const key = (entry) => (entry ? modelKeyOf(provider.id, entry) : main);
	const helper = family === "claude" ? pickModel(sameFamily, ["claude-haiku-5-5", /^claude-haiku/, /^claude-sonnet/])
		: family === "gpt" ? pickModel(sameFamily, [GPT_MINI_CLASS, /luna/])
			: null;
	const advisor = family === "claude" ? pickModel(sameFamily, ["claude-sonnet-5-5", /^claude-sonnet/])
		: family === "gpt" ? pickModel(sameFamily, ["gpt-6-astra"])
			: null;
	const vision = takesImages(model) ? model : models.find(takesImages);
	return { main, helper: key(helper), vision: key(vision), advisor: key(advisor) };
}

export function fallbackChain(mainKey, catalog) {
	const found = locateMain(mainKey, catalog);
	if (!found) return [];
	const { providers, provider, main, family, sameFamily } = found;
	const chain = [];
	// The same model served by another signed-in provider is the closest substitute there is.
	for (const other of providers) {
		if (other === provider || !other?.signedIn || !Array.isArray(other.models)) continue;
		const same = other.models.find((model) => model?.id === main.id);
		if (same) chain.push(modelKeyOf(other.id, same));
	}
	// Then a step down main's own family on main's provider.
	if (family === "claude") {
		const tier = CLAUDE_TIERS.indexOf(claudeTier(main.id));
		if (tier !== -1) {
			for (const lower of CLAUDE_TIERS.slice(tier + 1)) {
				const model = claudeTierModel(sameFamily, main.id, lower);
				if (model) chain.push(modelKeyOf(provider.id, model));
			}
		}
	} else if (family === "gpt" && !GPT_MINI_CLASS.test(main.id)) {
		for (const model of [pickModel(sameFamily, ["gpt-6-astra"]), pickModel(sameFamily, [GPT_MINI_CLASS])]) {
			if (model) chain.push(modelKeyOf(provider.id, model));
		}
	}
	const mainKeyFound = modelKeyOf(provider.id, main);
	return [...new Set(chain)].filter((key) => key !== mainKeyFound).slice(0, 3);
}

/** `roles.byMain` for listAgentModels: every model of every signed-in provider. */
export function rolesByMain(catalog) {
	const byMain = {};
	for (const provider of catalog.providers) {
		if (!provider.signedIn) continue;
		for (const model of provider.models) {
			const { helper, vision, advisor } = resolveRoleModels(model.key, catalog);
			byMain[model.key] = { helper, vision, advisor, fallback: fallbackChain(model.key, catalog) };
		}
	}
	return { byMain };
}
