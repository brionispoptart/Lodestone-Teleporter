import { ButtonState, EquipmentSlot, InputButton, MolangVariableMap, system, world } from "@minecraft/server";


const sessionState = new Map();
const pendingTuneState = new Map();
const interval = 1000;
const requiredSneaks = 3;
const validCompassTypes = new Set(["minecraft:compass", "minecraft:lodestone_compass"]);
const lorePrefix = "LT|";
const loreUniquePrefix = "LTID|";
const maxTuneWriteAttempts = 10;

function safePlaySound(dimension, soundId, location) {
    try {
        dimension.playSound(soundId, location, { volume: 1.0, pitch: 1.0 });
    } catch {
        // Keep gameplay stable even if a sound id is unavailable in this client/version.
    }
}

function safeSpawnParticle(dimension, particleId, location, molangVariables) {
    try {
        dimension.spawnParticle(particleId, location, molangVariables);
    } catch {
        // Keep gameplay stable even if a particle id is unavailable in this client/version.
    }
}

function spawnPurpleFlameCloud(dimension, center, molang) {
    const offsets = [
        { x: 0, y: 0.1, z: 0 },
        { x: 0, y: 0.6, z: 0 },
        { x: 0, y: 1.1, z: 0 },
        { x: 0.6, y: 0.2, z: 0 },
        { x: -0.6, y: 0.2, z: 0 },
        { x: 0, y: 0.2, z: 0.6 },
        { x: 0, y: 0.2, z: -0.6 },
        { x: 0.45, y: 0.6, z: 0.45 },
        { x: -0.45, y: 0.6, z: 0.45 },
        { x: 0.45, y: 0.6, z: -0.45 },
        { x: -0.45, y: 0.6, z: -0.45 },
        { x: 0.8, y: 0.9, z: 0 },
        { x: -0.8, y: 0.9, z: 0 },
        { x: 0, y: 0.9, z: 0.8 },
        { x: 0, y: 0.9, z: -0.8 },
        { x: 0.55, y: 1.3, z: 0.2 },
        { x: -0.55, y: 1.3, z: 0.2 },
        { x: 0.55, y: 1.3, z: -0.2 },
        { x: -0.55, y: 1.3, z: -0.2 },
    ];

    for (const offset of offsets) {
        const location = {
            x: center.x + offset.x,
            y: center.y + offset.y,
            z: center.z + offset.z,
        };
        safeSpawnParticle(dimension, "minecraft:colored_flame_particle", location, molang);
    }

    safeSpawnParticle(dimension, "minecraft:basic_portal_particle", center);
}

function playTeleportEffects(fromDimension, fromLocation, toDimension, toLocation) {
    const soundIds = [
        "mob.endermen.portal",
        "random.teleport",
    ];

    const purpleMolang = new MolangVariableMap();
    purpleMolang.setColorRGB("variable.color", { red: 0.62, green: 0.12, blue: 0.93 });

    for (const soundId of soundIds) {
        safePlaySound(fromDimension, soundId, fromLocation);
        safePlaySound(toDimension, soundId, toLocation);
    }

    spawnPurpleFlameCloud(fromDimension, fromLocation, purpleMolang);
    spawnPurpleFlameCloud(toDimension, toLocation, purpleMolang);
}

function buildLodestoneLoreLine(x, y, z, dimensionId) {
    return `${lorePrefix}${x}|${y}|${z}|${dimensionId}`;
}

function buildUniqueLoreLine() {
    const token = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    return `${loreUniquePrefix}${token}`;
}

function parseLodestoneLoreLine(loreLine) {
    if (!loreLine || !loreLine.startsWith(lorePrefix)) return;

    const encoded = loreLine.slice(lorePrefix.length);
    const parts = encoded.split("|");
    if (parts.length < 4) return;

    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    const dimensionId = parts.slice(3).join("|");

    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z) || !dimensionId) return;

    return { x, y, z, dimensionId };
}

function getStoredTargetFromItem(itemStack) {
    const loreLines = itemStack.getLore();
    const matchingLine = loreLines.find((line) => line.startsWith(lorePrefix));
    if (!matchingLine) return;

    return parseLodestoneLoreLine(matchingLine);
}

function snapshotInventory(container) {
    const snapshot = [];

    for (let slotIndex = 0; slotIndex < container.size; slotIndex++) {
        const item = container.getItem(slotIndex);
        snapshot.push({
            typeId: item?.typeId,
            amount: item?.amount ?? 0,
        });
    }

    return snapshot;
}

function pickCompassSlotForTargetWrite(player, beforeSnapshot) {
    const equippable = player.getComponent("minecraft:equippable");
    const inventoryComp = player.getComponent("minecraft:inventory");
    if (!equippable || !inventoryComp || !inventoryComp.container) return;

    const mainhandSlot = equippable.getEquipmentSlot(EquipmentSlot.Mainhand);
    const mainhandItem = mainhandSlot.getItem();

    if (mainhandItem && mainhandItem.typeId === "minecraft:lodestone_compass") {
        return mainhandSlot;
    }

    const container = inventoryComp.container;

    // Prefer the exact slot that changed into a new lodestone compass during the interaction.
    if (beforeSnapshot && beforeSnapshot.length === container.size) {
        for (let slotIndex = 0; slotIndex < container.size; slotIndex++) {
            const slot = container.getSlot(slotIndex);
            const item = slot.getItem();
            if (!item || item.typeId !== "minecraft:lodestone_compass") continue;

            const lore = slot.getLore();
            const hasTarget = lore.some((line) => line.startsWith(lorePrefix));
            const hasUnique = lore.some((line) => line.startsWith(loreUniquePrefix));
            if (hasTarget || hasUnique) continue;

            const before = beforeSnapshot[slotIndex];
            const becameLodestoneCompass = before.typeId !== "minecraft:lodestone_compass";
            const lodestoneCountChanged = before.amount !== item.amount;

            if (becameLodestoneCompass || lodestoneCountChanged) {
                return slot;
            }
        }
    }

    let fallbackSlot;

    for (let slotIndex = 0; slotIndex < container.size; slotIndex++) {
        const slot = container.getSlot(slotIndex);
        const item = slot.getItem();
        if (!item || item.typeId !== "minecraft:lodestone_compass") continue;

        const lore = slot.getLore();
        const hasTarget = lore.some((line) => line.startsWith(lorePrefix));
        const hasUnique = lore.some((line) => line.startsWith(loreUniquePrefix));

        if (!hasTarget && !hasUnique && item.amount === 1) {
            return slot;
        }

        if (!hasTarget && !hasUnique && !fallbackSlot) {
            fallbackSlot = slot;
            continue;
        }

        if (!hasTarget && !fallbackSlot) {
            fallbackSlot = slot;
        }
    }

    return fallbackSlot;
}

function setStoredTargetOnCompass(player, x, y, z, dimensionId, beforeSnapshot) {
    const targetSlot = pickCompassSlotForTargetWrite(player, beforeSnapshot);
    if (!targetSlot) return false;

    const cleanedLore = targetSlot
        .getLore()
        .filter((line) => !line.startsWith(lorePrefix) && !line.startsWith(loreUniquePrefix));
    cleanedLore.push(buildLodestoneLoreLine(x, y, z, dimensionId));
    cleanedLore.push(buildUniqueLoreLine());
    targetSlot.setLore(cleanedLore);
    return true;
}

function writeTargetWithRetries(player, x, y, z, dimensionId, beforeSnapshot, attempt = 0) {
    try {
        if (setStoredTargetOnCompass(player, x, y, z, dimensionId, beforeSnapshot)) {
            return;
        }
    } catch {
        return;
    }

    if (attempt >= maxTuneWriteAttempts) {
        return;
    }

    system.runTimeout(() => {
        writeTargetWithRetries(player, x, y, z, dimensionId, beforeSnapshot, attempt + 1);
    }, 1);
}

world.beforeEvents.playerLeave.subscribe((e) => {
    sessionState.delete(e.player.id);
    pendingTuneState.delete(e.player.id);
});

world.beforeEvents.playerInteractWithBlock.subscribe((e) => {
    const { block, itemStack, player } = e;
    if (!itemStack || !validCompassTypes.has(itemStack.typeId)) return;
    if (block.typeId !== "minecraft:lodestone") return;

    const inventoryComp = player.getComponent("minecraft:inventory");
    if (!inventoryComp || !inventoryComp.container) return;

    pendingTuneState.set(player.id, snapshotInventory(inventoryComp.container));
});

world.afterEvents.playerButtonInput.subscribe((e) => {
    const player = e.player;
    const time = Date.now();
    
    let data = sessionState.get(player.id) || { lastSneakTime: 0, sneakCount: 0 };

    if (time - data.lastSneakTime > interval) {
        data.sneakCount = 0;
    }

    data.sneakCount++;
    data.lastSneakTime = time;
    sessionState.set(player.id, data);

    if (data.sneakCount >= requiredSneaks) {
        teleportPlayer(player);
        data.sneakCount = 0; 
    }
}, {
    buttons: [InputButton.Sneak],
    state: ButtonState.Pressed,
});

world.afterEvents.playerInteractWithBlock.subscribe((e) => {
    const { block, itemStack, player } = e;

    if (!itemStack || !validCompassTypes.has(itemStack.typeId)) return;
    if (block.typeId !== "minecraft:lodestone") return;

    const { x, y, z } = block.location;
    const dimensionId = block.dimension.id;
    const beforeSnapshot = pendingTuneState.get(player.id);
    pendingTuneState.delete(player.id);

    // Retry across several ticks so we reliably tag the same item through vanilla compass conversion timing.
    writeTargetWithRetries(player, x, y, z, dimensionId, beforeSnapshot);
});

function teleportPlayer(player) {
    const equippable = player.getComponent("minecraft:equippable");
    if (!equippable) return;

    const heldItem = equippable.getEquipment(EquipmentSlot.Mainhand);
    if (!heldItem) return;

    if (!validCompassTypes.has(heldItem.typeId)) return;

    const storedTarget = getStoredTargetFromItem(heldItem);
    if (!storedTarget) return;

    const { x: lodeX, y: lodeY, z: lodeZ, dimensionId: lodeDimension } = storedTarget;

    let targetDimension;
    try {
        targetDimension = world.getDimension(lodeDimension);
    } catch {
        return;
    }

    const fromDimension = player.dimension;
    const fromLocation = { x: player.location.x, y: player.location.y, z: player.location.z };
    const toLocation = { x: Math.floor(lodeX) + 0.5, y: Math.floor(lodeY) + 1.5, z: Math.floor(lodeZ) + 0.5 };

    // No block/chunk lookups: player.teleport loads the destination itself, so this works from any
    // distance, dimension, or realm regardless of whether the target chunk is currently loaded.
    try {
        playTeleportEffects(fromDimension, fromLocation, targetDimension, toLocation);
        player.teleport(toLocation, { dimension: targetDimension });
        playTeleportEffects(targetDimension, toLocation, targetDimension, toLocation);
    } catch {
        return;
    }

    const healthComponent = player.getComponent("minecraft:health");
    const healthValue = healthComponent?.currentValue;

    if (typeof healthValue === "number" && healthValue <= 2) {
        world.sendMessage(`${player.name} has used a lodestone teleporter, narrowly escaping the sweet release of their inventory`);
    } else {
        world.sendMessage(`${player.name} has teleported to a lodestone`);
    }
}