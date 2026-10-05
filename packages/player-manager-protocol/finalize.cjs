require("node:fs").writeFileSync(
	new URL(
		"./dist/cjs/package.json",
		require("node:url").pathToFileURL(__filename),
	),
	JSON.stringify({type: "commonjs"}),
);
