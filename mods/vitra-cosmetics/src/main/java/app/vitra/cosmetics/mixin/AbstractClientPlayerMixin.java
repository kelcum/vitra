package app.vitra.cosmetics.mixin;

import app.vitra.cosmetics.Capes;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.core.ClientAsset;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Swaps in the player's Vitra cape. Hooking here, after the skin is looked up, means a Vitra cape
 * wins over OptiFine and other cape mods when a player has both.
 */
@Mixin(AbstractClientPlayer.class)
abstract class AbstractClientPlayerMixin {
    @Inject(method = "getSkin", at = @At("RETURN"), cancellable = true)
    private void vitra$cape(CallbackInfoReturnable<PlayerSkin> cir) {
        ClientAsset.Texture cape = Capes.textureFor(((AbstractClientPlayer) (Object) this).getUUID());
        if (cape == null) return;
        PlayerSkin skin = cir.getReturnValue();
        // Vitra capes include elytra wings in the same texture, so they double as the elytra.
        cir.setReturnValue(new PlayerSkin(skin.body(), cape, cape, skin.model(), skin.secure()));
    }
}
