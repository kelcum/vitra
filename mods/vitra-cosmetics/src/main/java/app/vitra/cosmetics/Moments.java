package app.vitra.cosmetics;

import com.google.gson.JsonObject;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientAdvancements;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.animal.axolotl.Axolotl;
import net.minecraft.world.entity.animal.cow.MushroomCow;
import net.minecraft.world.entity.animal.panda.Panda;
import net.minecraft.world.entity.animal.sheep.Sheep;
import net.minecraft.world.item.DyeColor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

public final class Moments {
    static final boolean ENABLED = Boolean.getBoolean("vitra.moments");
    private static final boolean DEBUG = Boolean.getBoolean("vitra.moments.debug");

    private static final Set<String> BIOME_LISTS = Set.of("minecraft:adventure/adventuring_time", "minecraft:nether/explore_nether");
    private static final Set<String> RARE_MOBS = Set.of(
        "minecraft:warden", "minecraft:elder_guardian", "minecraft:piglin_brute", "minecraft:evoker",
        "minecraft:illusioner", "minecraft:ravager", "minecraft:allay", "minecraft:sniffer",
        "minecraft:creaking", "minecraft:skeleton_horse");
    private static final double SIGHT = 24;
    private static final int BURST = 3;

    private static ClientAdvancements tracked;
    private static final Map<Identifier, Boolean> done = new HashMap<>();
    private static final Map<Identifier, Set<String>> criteria = new HashMap<>();
    private static final Set<String> sighted = new HashSet<>();
    private static String lastPlace = "";

    private Moments() {}

    public static void start() {
        Thread t = new Thread(Moments::run, "Vitra moments");
        t.setDaemon(true);
        t.start();
        if (ENABLED) VitraCosmetics.LOG.info("Vitra moments: ready");
    }

    private static void run() {
        while (true) {
            try {
                Minecraft.getInstance().submit(Moments::tick).get(5, TimeUnit.SECONDS);
            } catch (Exception e) {
                VitraCosmetics.LOG.debug("moments check failed", e);
            }
            try {
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private static void tick() {
        String place = place();
        if (!place.equals(lastPlace)) {
            lastPlace = place;
            VitraCosmetics.LOG.info("Vitra presence: {}", place);
        }
        if (!ENABLED) return;
        Minecraft mc = Minecraft.getInstance();
        ClientPacketListener connection = mc.getConnection();
        LocalPlayer player = mc.player;
        ClientLevel level = mc.level;
        if (connection == null || player == null || level == null) {
            tracked = null;
            return;
        }
        ClientAdvancements advancements = connection.getAdvancements();
        if (advancements != tracked) {
            tracked = advancements;
            done.clear();
            criteria.clear();
            sighted.clear();
        }
        checkAdvancements(advancements, player, level);
        checkMobs(player, level);
    }

    private static void checkAdvancements(ClientAdvancements advancements, LocalPlayer player, ClientLevel level) {
        List<JsonObject> found = new ArrayList<>();
        for (Map.Entry<AdvancementHolder, AdvancementProgress> e : advancements.progress().entrySet()) {
            Identifier id = e.getKey().id();
            AdvancementProgress progress = e.getValue();
            boolean now = progress.isDone();
            Boolean before = done.put(id, now);
            DisplayInfo display = e.getKey().value().display().orElse(null);
            if (before != null && !before && now && (display != null || DEBUG)) {
                JsonObject o = new JsonObject();
                o.addProperty("kind", "advancement");
                o.addProperty("id", id.toString());
                if (display != null) {
                    o.addProperty("frame", display.type().getSerializedName());
                    o.addProperty("title", display.title().getString());
                    o.addProperty("description", display.description().getString());
                }
                found.add(o);
            }
            if (BIOME_LISTS.contains(id.toString())) {
                Set<String> finished = new HashSet<>();
                progress.getCompletedCriteria().forEach(finished::add);
                Set<String> earlier = criteria.put(id, finished);
                if (earlier == null) continue;
                for (String biome : finished) {
                    if (earlier.contains(biome)) continue;
                    JsonObject o = new JsonObject();
                    o.addProperty("kind", "biome");
                    o.addProperty("id", biome);
                    o.addProperty("name", biomeName(biome));
                    found.add(o);
                }
            }
        }
        if (found.size() > BURST) return;
        for (JsonObject o : found) report(o, player, level);
    }

    private static void checkMobs(LocalPlayer player, ClientLevel level) {
        for (Entity entity : level.entitiesForRendering()) {
            if (entity == player || entity.distanceToSqr(player) > SIGHT * SIGHT) continue;
            String kind = rareKind(entity);
            if (kind == null || sighted.contains(kind) || !player.hasLineOfSight(entity)) continue;
            sighted.add(kind);
            JsonObject o = new JsonObject();
            o.addProperty("kind", "mob");
            o.addProperty("id", kind);
            o.addProperty("name", entity.getName().getString());
            report(o, player, level);
        }
    }

    private static String rareKind(Entity entity) {
        String type = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
        if (RARE_MOBS.contains(type)) return type;
        if (entity instanceof Axolotl a && a.getVariant() == Axolotl.Variant.BLUE) return type + "/blue";
        if (entity instanceof Sheep s && s.getColor() == DyeColor.PINK) return type + "/pink";
        if (entity instanceof Panda p && p.isBrown()) return type + "/brown";
        if (entity instanceof MushroomCow m && m.getVariant() == MushroomCow.Variant.BROWN) return type + "/brown";
        return DEBUG ? type : null;
    }

    private static String biomeName(String id) {
        Identifier biome = Identifier.tryParse(id);
        return biome == null ? id : Component.translatable("biome." + biome.getNamespace() + "." + biome.getPath()).getString();
    }

    private static void report(JsonObject o, LocalPlayer player, ClientLevel level) {
        BlockPos pos = player.blockPosition();
        o.addProperty("dimension", level.dimension().identifier().toString());
        level.getBiome(pos).unwrapKey().ifPresent(k -> {
            o.addProperty("biome", k.identifier().toString());
            o.addProperty("biomeName", biomeName(k.identifier().toString()));
        });
        o.addProperty("x", pos.getX());
        o.addProperty("y", pos.getY());
        o.addProperty("z", pos.getZ());
        VitraCosmetics.LOG.info("Vitra moment: {}", o);
    }

    private static String place() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getConnection() == null) return "menu";
        if (mc.getSingleplayerServer() != null) return "world";
        ServerData server = mc.getCurrentServer();
        if (server == null) return "world";
        return server.isRealm() ? "realms" : "server " + server.ip;
    }
}
