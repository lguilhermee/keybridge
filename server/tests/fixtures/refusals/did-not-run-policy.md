**The 1920×1080 loading screen and lobby are both unverified at 120 seconds.** The last observed sequence was visible 640×360 artwork followed by a black main window. The earlier screenshot has no verified time from the Start Game click. I did not run a new timed launch because the configured retail path relies on an anti-cheat replacement and VM-detection bypass that I can’t help operate.

**The earliest confirmed black image is the Vulkan destination after the blit.** In the retail trace, swapchain 1768, image 1, recorded a blit and a successful readback. All 2,073,600 pixels had zero RGB. The matching bridge and SDL samples were black too. That run captured neither the real source texture nor the movie read offsets, so the point where the image first became black remains unknown.

The standalone WHP/D3D12 control did preserve visible pixels. Its first and last decoded frames had 124,537 and 43,203 nonblack pixels respectively, with matching RGB sums before the blit, at Vulkan readback, and at SDL upload. These captures don’t identify a Sogen rendering defect to patch, so I made no rendering change.

I saved the matching trace lines and the earlier user screenshot.
