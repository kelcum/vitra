package app.vitra.cosmetics;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class VitraCosmetics implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("Vitra Cosmetics");
    public static final String API = System.getProperty("vitra.cosmetics.api", "https://api.xan.gripe");
    public static final String TOKEN = System.getProperty("vitra.cosmetics.token", "");
    public static final boolean OFF = Boolean.getBoolean("vitra.cosmetics.off");

    public static boolean badgesAvailable;

    @Override
    public void onInitializeClient() {
        FabricLoader loader = FabricLoader.getInstance();
        badgesAvailable = loader.isModLoaded("fabric-resource-loader-v1") || loader.isModLoaded("fabric-resource-loader-v0");
        if (!badgesAvailable && !OFF) LOG.warn("Fabric API isn't installed, so Vitra badges are off (capes still work)");
        if (Boolean.getBoolean("vitra.cosmetics.selftest")) selfTest();
        if (!OFF) Directory.start();
        Moments.start();
    }

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
