package app.vitra.cosmetics.mixin;

import app.vitra.cosmetics.Badge;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Player.class)
abstract class PlayerMixin {
    @Inject(method = "getDisplayName", at = @At("RETURN"), cancellable = true)
    private void vitra$badge(CallbackInfoReturnable<Component> cir) {
        if ((Object) this instanceof AbstractClientPlayer player) {
            cir.setReturnValue(Badge.decorate(player.getUUID(), cir.getReturnValue()));
        }
    }
}
