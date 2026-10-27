#!/usr/bin/env node
import { readFileSync } from "node:fs";

const browser = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
const guide = readFileSync(new URL("../src/first-success-guide.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/project-browser.css", import.meta.url), "utf8");
let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

expect("start screen has the v2 region root", browser.includes('className={`v2-start-screen project-browser-backdrop'));
expect("start screen has the three navigation destinations", ["Recent", "New Project", "Learn"].every((label) => browser.includes(`label: ko("${label}"`)) && !browser.includes('label: ko("Samples"'));
expect("start screen exposes the template grid and the + card as its one blank entry", browser.includes("v2-start-template-grid") && browser.includes('data-testid="start-new-project-card"') && !browser.includes("BLANK_TEMPLATE") && !browser.includes("v2-start-tabs"));
expect("the New view offers an Open project card beside the + card that opens a project file", /data-testid="start-open-project-card" onClick=\{onOpenFile\}/.test(browser));
expect("an empty recent list offers to open a project file", browser.includes('className="v2-start-empty-open" onClick={onOpenFile}') && (browser.match(/onOpenFile=\{onOpenFile\}/g) || []).length === 2);
expect("start screen exposes the name and storage fields", browser.includes('data-testid="start-project-name"') && browser.includes('ko("Location"') && browser.includes('ko("Frame rate"') && browser.includes('ko("Units"'));
expect("empty project names disable Create with a reason title", browser.includes("disabled={!canCreate}") && browser.includes("createReason"));
expect("the first-success guide keeps its v2 region root", guide.includes('className="v2-first-success-guide first-success-guide"'));
expect("all new visual rules are rooted in the v2 regions", css.includes(".v2-start-screen") && css.includes(".v2-first-success-guide") && !/^\.(project-browser|first-success-guide)/m.test(css));
expect("the v2 screen keeps the fixed 232px and 340px columns", css.includes("var(--start-nav-width, 232px)") && css.includes("var(--start-preview-width, 340px)"));

// Previs modes (#649, #654): the New view's Storyboard/Animation control always
// renders on the New view, offers exactly two options with ko/en copy, and
// Storyboard narrows the templates to the blank stage.
const modeBlock = browser.slice(browser.indexOf("const MODE_OPTIONS = ["), browser.indexOf("];", browser.indexOf("const MODE_OPTIONS = [")));
const choices = readFileSync(new URL("../src/project-start-choices.jsx", import.meta.url), "utf8");
expect("the mode control renders on the New view without a flag", !browser.includes("previs-flag") && browser.includes('{activeNav === "new" && (') && browser.includes('testId="start-previs-mode" dataKey="previs-mode" options={MODE_OPTIONS}') && choices.includes('role="radiogroup"'));
expect("the mode control offers exactly Storyboard and Animation", (modeBlock.match(/\bid: "/g) || []).length === 2 && modeBlock.includes('id: "storyboard"') && modeBlock.includes('id: "animation"'));
expect("both mode labels carry en and ko copy", modeBlock.includes('ko("Storyboard", "스토리보드")') && modeBlock.includes('ko("Animation", "애니메이션")'));
expect("both mode blurbs carry en and ko copy", modeBlock.includes('ko("Describe scenes in words and direct one panel at a time. Output: image references.", "말로 장면을 설명하면 한 장씩 패널을 연출합니다. 결과물: 이미지 레퍼런스.")') && modeBlock.includes('ko("Block and shoot continuous motion. Output: clip references.", "연속 동작을 블로킹하고 촬영합니다. 결과물: 클립 레퍼런스.")'));
expect("Animation is the default mode", browser.includes("useState(DEFAULT_PREVIS_MODE)"));
expect("Storyboard offers only the blank stage", browser.includes('previsMode === "storyboard" ? [] : starterTemplates'));
expect("Create carries the chosen mode and cast style", browser.includes("onNew(projectName, { previsMode, castStyle })") && browser.includes('onStarter?.(selectedTemplate.starterId, projectName, { previsMode: "animation", castStyle })'));

// Cast style: a second radiogroup under the mode control offers Humanoid,
// Capsule and Hybrid with ko/en copy; Hybrid is the default.
const castBlock = choices.slice(choices.indexOf("export const CAST_OPTIONS = ["), choices.indexOf("];", choices.indexOf("export const CAST_OPTIONS = [")));
expect("the cast-style control sits under the mode control", browser.indexOf('testId="start-cast-style"') > browser.indexOf('testId="start-previs-mode"') && browser.includes('dataKey="cast-style" options={CAST_OPTIONS} value={castStyle}'));
expect("the cast-style control offers rig, capsule and hybrid in that order", (castBlock.match(/\bid: "/g) || []).length === 3 && castBlock.indexOf('id: "rig"') < castBlock.indexOf('id: "capsule"') && castBlock.indexOf('id: "capsule"') < castBlock.indexOf('id: "hybrid"'));
expect("every cast-style label carries en and ko copy", castBlock.includes('ko("Humanoid", "휴머노이드")') && castBlock.includes('ko("Capsule", "캡슐")') && castBlock.includes('ko("Hybrid", "하이브리드")'));
expect("Hybrid is the default cast style", browser.includes("useState(DEFAULT_CAST_STYLE)"));

if (failures) process.exitCode = 1;
else console.log("all v2 start-screen checks PASS");
