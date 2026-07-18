import { mkdir, readFile, writeFile } from "node:fs/promises";

const artifactPath = new URL("../contracts/out/ArcLaunchpad.sol/ArcLaunchpadFactory.json", import.meta.url);
const outputPath = new URL("../src/generated/arcLaunchpadFactory.ts", import.meta.url);
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const pumpSuiteArtifactPath = new URL("../contracts/out/ArcPumpV7.sol/ArcPumpSuiteV7.json", import.meta.url);
const pumpSuiteOutputPath = new URL("../src/generated/arcPumpSuite.ts", import.meta.url);
const pumpSuiteArtifact = JSON.parse(await readFile(pumpSuiteArtifactPath, "utf8"));
const pumpFactoryArtifactPath = new URL("../contracts/out/ArcPumpV7.sol/ArcPumpFactoryV7.json", import.meta.url);
const pumpFactoryOutputPath = new URL("../src/generated/arcPumpFactory.ts", import.meta.url);
const pumpFactoryArtifact = JSON.parse(await readFile(pumpFactoryArtifactPath, "utf8"));
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(outputPath, `// Generated from Foundry artifact. Do not edit.\nexport const ARC_FACTORY_ABI = ${JSON.stringify(artifact.abi)} as const;\nexport const ARC_FACTORY_BYTECODE = ${JSON.stringify(artifact.bytecode.object)};\n`);
await writeFile(pumpSuiteOutputPath, `// Generated from Foundry artifact. Do not edit.\nexport const ARC_PUMP_SUITE_ABI = ${JSON.stringify(pumpSuiteArtifact.abi)} as const;\n`);
await writeFile(new URL("../src/generated/arcPumpSuiteBytecode.ts", import.meta.url), `// Generated from Foundry artifact. Do not edit.\nexport const ARC_PUMP_SUITE_BYTECODE = ${JSON.stringify(pumpSuiteArtifact.bytecode.object)};\n`);
await writeFile(pumpFactoryOutputPath, `// Generated from Foundry artifact. Do not edit.\nexport const ARC_PUMP_FACTORY_ABI = ${JSON.stringify(pumpFactoryArtifact.abi)} as const;\n`);
