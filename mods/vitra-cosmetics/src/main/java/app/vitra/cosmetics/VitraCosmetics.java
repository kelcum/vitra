package app.vitra.cosmetics;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Shows a small Vitra badge next to the names of players using Vitra, and the capes they picked in
 * Vitra (animated ones too). Only players who have this mod see them, like any client's cosmetics.
 *
 * Vitra starts the game with -Dvitra.cosmetics.token=… so this player counts as "on Vitra" while
 * they play; without a token the mod still shows everyone else's badges and capes.
 */
public final class VitraCosmetics implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("Vitra Cosmetics");
    public static final String API = System.getProperty("vitra.cosmetics.api", "https://api.xan.gripe");
    public static final String TOKEN = System.getProperty("vitra.cosmetics.token", "");

    /** The badge is a glyph in this mod's font, which only loads when Fabric API's resource loader is there. */
    public static boolean badgesAvailable;

    @Override
    public void onInitializeClient() {
        FabricLoader loader = FabricLoader.getInstance();
        badgesAvailable = loader.isModLoaded("fabric-resource-loader-v1") || loader.isModLoaded("fabric-resource-loader-v0");
        if (!badgesAvailable) LOG.warn("Fabric API isn't installed, so Vitra badges are off (capes still work)");
        if (Boolean.getBoolean("vitra.cosmetics.selftest")) selfTest();
        Directory.start();
    }

    /** Loads every class this mod changes, so a broken hook shows up at startup instead of mid-game. */
    private static void selfTest() {
        for (String c : new String[] {
            "net.minecraft.world.entity.player.Player",
            "net.minecraft.client.player.AbstractClientPlayer",
            "net.minecraft.client.gui.components.PlayerTabOverlay",
        }) {
            try {
                Class.forName(c, true, VitraCosmetics.class.getClassLoader());
            } catch (Throwable t) {
                LOG.error("Vitra Cosmetics self-test failed on {}", c, t);
                return;
            }
        }
        LOG.info("Vitra Cosmetics self-test passed");
    }
}
