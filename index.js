const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const cliProgress = require("cli-progress");
require("dotenv").config();
const { ApiPromise } = require("@polkadot/api");
const { HttpProvider } = require("@polkadot/rpc-provider");
const { xxhashAsHex } = require("@polkadot/util-crypto");
const execFileSync = require("child_process").execFileSync;
const execSync = require("child_process").execSync;
const binaryPath = path.join(__dirname, "data", "binary");
const wasmPath = path.join(__dirname, "data", "runtime.wasm");
const schemaPath = path.join(__dirname, "data", "schema.json");
const hexPath = path.join(__dirname, "data", "runtime.hex");
const originalSpecPath = path.join(__dirname, "data", "genesis.json");
const forkedSpecPath = path.join(__dirname, "data", "fork.json");
const storagePath = path.join(__dirname, "data", "storage.json");

// Using http endpoint since substrate's WS endpoint has a size limit.
const provider = new HttpProvider(
  process.env.HTTP_RPC_ENDPOINT || "http://localhost:9933"
);
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

const alice = process.env.ALICE || "";
const originalChain = process.env.ORIG_CHAIN || "";
const forkChain = process.env.FORK_CHAIN || "";
const pageSize = process.env.PAGE_SIZE || 100;
const parachainSpecPath = process.env.PARACHAIN || "";

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar(
  {},
  cliProgress.Presets.shades_classic
);

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 * 
 * If you want to skip specific key within a allowed module, add the prefix(hex) manually to skippedPrefixes.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 *
 * we need to take snapshot of following 13 modules and System.Account storages only.
 *
 * 1. admin
 * 2. balances
 * 3. credits
 * 4. dct
 * 5. giant_sudo
 * 6. offers
 * 7. provider
 * 8. reward
 * 9. sgiantBalances
 * 10. staking
 * 11. uniques
 * 12. validatorStake
 * 13. vesting
 *
 */
let prefixes = [
  "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9" /* System.Account */,
];
const skippedModulesPrefix = [
  "Aura",
  "Grandpa",
  "Identity",
  "Session",
  "Substrate",
  "System",
  "Timestamp",
  "TransactionPayment",
  "ValidatorSet",
];
const skippedPrefixes = [
  "0x30db7d3f47a0e1e95d08406497cbc95d183af6c2a611d10d3c89af247d1af0f8", // DctExpiry
  "0x30db7d3f47a0e1e95d08406497cbc95de556acf9d5dcb43ba1cd73e9244a540c", // DctDelayedRevenue
  "0x30db7d3f47a0e1e95d08406497cbc95d3a42a7dddf1b16a1dc1cd5c92d9cb0a5", // DctYieldRewardee
];

async function fixParachinStates(api, forkedSpec) {
  const skippedKeys = [api.query.parasScheduler.sessionStartBlock.key()];
  for (const k of skippedKeys) {
    delete forkedSpec.genesis.raw.top[k];
  }
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    console.log(
      chalk.red(
        'Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'
      )
    );
    process.exit(1);
  }
  execFileSync("chmod", ["+x", binaryPath]);

  if (!fs.existsSync(wasmPath)) {
    console.log(
      chalk.red(
        'WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'
      )
    );
    process.exit(1);
  }
  execSync("cat " + wasmPath + " | hexdump -ve '/1 \"%02x\"' > " + hexPath);

  let api;
  console.log(
    chalk.green(
      "We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them."
    )
  );
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow("Custom Schema missing, using default schema."));
    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(
      chalk.yellow(
        "Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage"
      )
    );
  } else {
    // Download state of original chain
    console.log(
      chalk.green(
        "Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain."
      )
    );
    let at = (await api.rpc.chain.getBlockHash()).toString();
    console.log(chalk.cyan(`Taking state snapshot of chain at: ${at}`));
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: "a" });
    stream.write("[");
    await fetchChunks("0x", chunksLevel, stream, at);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = metadata.asLatest.pallets;
  modules.forEach((module) => {
    if (module.storage) {
      if (!skippedModulesPrefix.includes(module.name.toString())) {
        prefixes.push(xxhashAsHex(module.name, 128));
        console.log(chalk.cyan(`Selected module ${module.name} for snapshot.`));
      }
    }
  });

  console.log(
    chalk.cyan(
      `Total ${prefixes.length} modules are selected for state snapshot.`
    )
  );
  // Generate chain spec for original and forked chains
  if (originalChain == "") {
    execSync(
      binaryPath +
        ` build-spec --raw --disable-default-bootnode > ` +
        originalSpecPath
    );
  } else {
    execSync(
      binaryPath +
        ` build-spec --chain ${originalChain} --raw --disable-default-bootnode > ` +
        originalSpecPath
    );
  }
  if (forkChain == "") {
    execSync(
      binaryPath +
        ` build-spec --dev --raw --disable-default-bootnode > ` +
        forkedSpecPath
    );
  } else {
    execSync(
      binaryPath +
        ` build-spec --chain ${forkChain} --raw --disable-default-bootnode > ` +
        forkedSpecPath
    );
  }

  let storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, "utf8"));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, "utf8"));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + "-fork";
  forkedSpec.id = originalSpec.id + "-fork";
  forkedSpec.protocolId = originalSpec.protocolId;

  let migrated_storages = 0;
  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter(
      (i) =>
        prefixes.some((prefix) => i[0].startsWith(prefix)) &&
        !skippedPrefixes.some((prefix) => i[0].startsWith(prefix))
    )
    .forEach(([key, value]) => {
      forkedSpec.genesis.raw.top[key] = value;
      migrated_storages += 1;
    });

  if (parachainSpecPath != "") {
    let paraMigrated = 0;
    let paraSpec = JSON.parse(fs.readFileSync(parachainSpecPath, "utf8"));
    storage
      .filter(
        (i) =>
          prefixes.some((prefix) => i[0].startsWith(prefix)) &&
          !skippedPrefixes.some((prefix) => i[0].startsWith(prefix))
      )
      .forEach(([key, value]) => {
        paraSpec.genesis.raw.top[key] = value;
        paraMigrated += 1;
      });
    fs.writeFileSync(parachainSpecPath, JSON.stringify(paraSpec, null, 4));
    console.log(
      chalk.cyan(
        `Updated ${paraMigrated} storages from existing chain to parachain spec.`
      )
    );
  }

  console.log(
    chalk.cyan(
      `Mapped ${migrated_storages} storages from existing chain to new spec.`
    )
  );
  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  // This storage must not have been backup since it is from system pallet
  // delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  fixParachinStates(api, forkedSpec);

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top["0x3a636f6465"] =
    "0x" + fs.readFileSync(hexPath, "utf8").trim();

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log(
    "Forked genesis generated successfully. Find it at ./data/fork.json"
  );
  process.exit();
}

main();

async function fetchChunks(prefix, levelsRemaining, stream, at) {
  if (levelsRemaining <= 0) {
    let startKey = null;
    while (true) {
      const keys = await provider.send("state_getKeysPaged", [
        prefix,
        pageSize,
        startKey,
        at,
      ]);
      if (keys.length > 0) {
        console.log(chalk.cyan(`Fetching ${keys.length} storage keys.`));
        let pairs = [];
        await Promise.all(
          keys.map(async (key) => {
            const value = await provider.send("state_getStorage", [key, at]);
            pairs.push([key, value]);
          })
        );

        separator ? stream.write(",") : (separator = true);
        stream.write(JSON.stringify(pairs).slice(1, -1));

        startKey = keys[keys.length - 1];
      }

      if (keys.length < pageSize) {
        break;
      }
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(
        fetchChunks(
          prefix + i.toString(16).padStart(2, "0"),
          levelsRemaining - 1,
          stream,
          at
        )
      );
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(
        prefix + i.toString(16).padStart(2, "0"),
        levelsRemaining - 1,
        stream,
        at
      );
    }
  }
}
