/*
 * VideoFetch media network-namespace holder.
 * (PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001)
 *
 * This process exists for exactly one reason: to keep a network namespace
 * alive so that
 *
 *   1. VM root can install and verify the safe-egress nftables policy INTO
 *      that namespace before any media code runs, and
 *   2. the Worker container can join it with `--network container:...` and
 *      inherit an already-enforced boundary.
 *
 * It is deliberately incapable of anything else. It opens no file, reads no
 * configuration, resolves no name, binds no socket and spawns no child. The
 * only syscalls it makes after start are sigprocmask(2) and sigwait(3).
 *
 * WHY C AND NOT `sleep infinity`
 *
 * The recovered prototype used `alpine:vf sleep infinity` — an opaque,
 * locally-built image that existed only on one VM and could not be rebuilt
 * from source. Replacing it with a statically linked binary lets the final
 * image be FROM scratch: no shell, no libc, no package manager, no busybox,
 * no /etc, nothing an attacker who reached this namespace could execute.
 *
 * SIGNAL HANDLING
 *
 * As PID 1 in its own PID namespace this process receives no default signal
 * dispositions, so an unhandled SIGTERM would be ignored and `docker stop`
 * would escalate to SIGKILL after its timeout. Blocking every signal and then
 * sigwait()ing for the termination set is the race-free way to accept SIGTERM:
 * unlike a handler plus pause(), there is no window in which the signal can
 * arrive unobserved.
 *
 * Nothing sharing this namespace is a child of this process (`--network
 * container:` shares only the NETWORK namespace, not the PID namespace), so
 * there are no zombies to reap.
 */

/* <stddef.h> for NULL, which sigprocmask(2) takes as its third argument.
 * It is included explicitly because the C standard defines NULL there, not
 * in <signal.h>. glibc happens to expose it transitively; musl does not, so
 * relying on that made the build succeed on some libcs and fail on the
 * pinned Alpine builder under -Wall -Wextra -Werror. */
#include <stddef.h>
#include <signal.h>

int main(void) {
    sigset_t block_all;
    sigset_t terminating;
    int signo = 0;

    /* Block everything, so nothing is delivered behind sigwait()'s back. */
    if (sigfillset(&block_all) != 0) {
        return 1;
    }
    if (sigprocmask(SIG_BLOCK, &block_all, NULL) != 0) {
        return 1;
    }

    /* SIGKILL and SIGSTOP cannot be blocked or waited for; the runtime uses
     * them as the escalation path and that is intentional. */
    if (sigemptyset(&terminating) != 0) {
        return 1;
    }
    if (sigaddset(&terminating, SIGTERM) != 0) {
        return 1;
    }
    if (sigaddset(&terminating, SIGINT) != 0) {
        return 1;
    }
    if (sigaddset(&terminating, SIGQUIT) != 0) {
        return 1;
    }

    for (;;) {
        if (sigwait(&terminating, &signo) == 0) {
            /* An orderly stop. The namespace goes away with this process, and
             * every unit bound to it is stopped by systemd in turn. */
            return 0;
        }
        /* sigwait() failed (EINTR is not returned by sigwait, but be strict):
         * retry rather than exit, because exiting would destroy the namespace
         * and take the boundary down for a non-reason. */
    }
}
