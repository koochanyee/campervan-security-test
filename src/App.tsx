
import { useState, useEffect } from "react";
import { WorkflowDiagram } from "./components/WorkflowDiagram";
import { CodeDisplay } from "./components/CodeDisplay";
import { BackgroundDots } from "./components/BackgroundDots";
import { useWorkflowWebSocket } from "./hooks/useWorkflowWebSocket";
import { WORKFLOW_STEPS } from "./types";

declare global {
	interface Window {
		google?: {
			accounts: {
				id: {
					initialize: (options: {
						client_id: string;
						callback: (response: { credential: string }) => void;
					}) => void;
					renderButton: (
						element: HTMLElement,
						options: { theme: string; size: string; text: string },
					) => void;
				};
			};
		};
	}
}


function App() {
    const [instanceId, setInstanceId] = useState<string | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [authMessage, setAuthMessage] = useState("");
    const [isVerifying, setIsVerifying] = useState(false);
    const [verifiedEmail, setVerifiedEmail] = useState("");

    // Restore the existing login session after a page refresh.
    useEffect(() => {
        let cancelled = false;

        async function restoreSession() {
            try {
                const result = await fetch("/api/auth/session", {
                    method: "GET",
                    credentials: "same-origin",
                });

                if (!result.ok) {
                    return;
                }

                const data = await result.json();

                if (!cancelled && data.success && data.user?.email) {
                    setVerifiedEmail(data.user.email);
                    setAuthMessage(
                        "Existing session restored. Trip access granted."
                    );
                }
            } catch (error) {
                console.error("Session restoration failed:", error);
            }
        }

        restoreSession();

        return () => {
            cancelled = true;
        };
    }, []);

    const workflowState = useWorkflowWebSocket(instanceId);


	useEffect(() => {
		if (workflowState.workflowStatus === "completed") {
			const timer = setTimeout(() => {
				setInstanceId(null);
			}, 1500);
			return () => clearTimeout(timer);
		}
	}, [workflowState.workflowStatus]);

	useEffect(() => {
		if (
			workflowState.workflowStatus === "running" &&
			workflowState.currentStep
		) {
			setIsStarting(false);
		}
	}, [workflowState.workflowStatus, workflowState.currentStep]);

	useEffect(() => {
		const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as
			| string
			| undefined;

		if (!clientId) {
			setAuthMessage("Google sign-in configuration is missing.");
			return;
		}

		let attempts = 0;
		let timer: ReturnType<typeof setInterval> | undefined;

		const setupGoogleSignIn = () => {
			if (!window.google?.accounts.id) {
				attempts += 1;
				if (attempts >= 20 && timer) clearInterval(timer);
				return;
			}

			if (timer) clearInterval(timer);

			const button = document.getElementById("google-sign-in-button");
			if (!button) return;

			button.replaceChildren();

			window.google.accounts.id.initialize({
				client_id: clientId,
				callback: async (response) => {
					setAuthMessage("Verifying Google account…");
					setIsVerifying(true);
					setVerifiedEmail("");

					try {
						const result = await fetch("/api/auth/google", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								credential: response.credential,
							}),
						});

						const data = await result.json();

						if (!result.ok || !data.success) {
							throw new Error(data.error || "Google verification failed.");
						}

						setVerifiedEmail(data.user.email);
						setAuthMessage(
							"Google identity verified. Trip access granted.",
						);
					} catch (error) {
						setAuthMessage(
							error instanceof Error
								? error.message
								: "Google verification failed. Please try again.",
						);
					} finally {
						setIsVerifying(false);
					}
				},
			});

			window.google.accounts.id.renderButton(button, {
				theme: "outline",
				size: "large",
				text: "signin_with",
			});
		};

		setupGoogleSignIn();

		if (!window.google?.accounts.id) {
			timer = setInterval(setupGoogleSignIn, 500);
		}

		return () => {
			if (timer) clearInterval(timer);
		};
	}, []);

	const handleStartWorkflow = async () => {
		setIsStarting(true);

		try {
			const response = await fetch("/api/workflow/start", {
				method: "POST",
			});

			if (!response.ok) {
				throw new Error("Failed to start workflow");
			}

			const data = await response.json();
			setInstanceId(data.instanceId);
		} catch {
			alert("Failed to start workflow. Please try again.");
			setIsStarting(false);
		}
	};

	return (
		<div className="min-h-screen bg-neutral-50/30 dark:bg-neutral-950 flex flex-col relative">
			<div className="absolute inset-0 text-neutral-200/50 dark:text-neutral-700/40 overflow-hidden">
				<BackgroundDots />
			</div>

			<header className="px-6 pt-6 pb-4 relative z-10">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<svg
							role="img"
							viewBox="0 0 460 271.2"
							aria-hidden="true"
							className="h-5 w-auto opacity-90"
						>
							<path
								fill="#FBAD41"
								d="M328.6,125.6c-0.8,0-1.5,0.6-1.8,1.4l-4.8,16.7c-2.1,7.2-1.3,13.8,2.2,18.7c3.2,4.5,8.6,7.1,15.1,7.4l26.2,1.6c0.8,0,1.5,0.4,1.9,1c0.4,0.6,0.5,1.5,0.3,2.2c-0.4,1.2-1.6,2.1-2.9,2.2l-27.3,1.6c-14.8,0.7-30.7,12.6-36.3,27.2l-2,5.1c-0.4,1,0.3,2,1.4,2h93.8c1.1,0,2.1-0.7,2.4-1.8c1.6-5.8,2.5-11.9,2.5-18.2c0-37-30.2-67.2-67.3-67.2C330.9,125.5,329.7,125.5,328.6,125.6z"
							/>
							<path
								fill="#F6821F"
								d="M292.8,204.4c2.1-7.2,1.3-13.8-2.2-18.7c-3.2-4.5-8.6-7.1-15.1-7.4l-123.1-1.6c-0.8,0-1.5-0.4-1.9-1s-0.5-1.4-0.3-2.2c0.4-1.2,1.6-2.1,2.9-2.2l124.2-1.6c14.7-0.7,30.7-12.6,36.3-27.2l7.1-18.5c0.3-0.8,0.4-1.6,0.2-2.4c-8-36.2-40.3-63.2-78.9-63.2c-35.6,0-65.8,23-76.6,54.9c-7-5.2-15.9-8-25.5-7.1c-17.1,1.7-30.8,15.4-32.5,32.5c-0.4,4.4-0.1,8.7,0.9,12.7c-27.9,0.8-50.2,23.6-50.2,51.7c0,2.5,0.2,5,0.5,7.5c0.2,1.2,1.2,2.1,2.4,2.1h227.2c1.3,0,2.5-0.9,2.9-2.2L292.8,204.4z"
							/>
						</svg>
						<div className="w-px h-4 bg-neutral-300/50 dark:bg-neutral-600/50" />
						<h1 className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
							Campervan Security Test
						</h1>
					</div>

					<a
						href="https://developers.cloudflare.com/workflows"
						target="_blank"
						rel="noopener noreferrer"
						className="text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors"
					>
						Documentation →
					</a>
				</div>
			</header>

			<section className="relative z-10 mx-6 mb-5 rounded-xl border border-neutral-200 bg-white/90 p-5 dark:border-neutral-800 dark:bg-neutral-900/90">
				<h2 className="mb-3 text-base font-semibold text-neutral-800 dark:text-neutral-100">
					M3 — Google Sign-in Test
				</h2>
				<div id="google-sign-in-button" />
				{isVerifying && (
					<p className="mt-3 text-sm text-neutral-600">Verifying account…</p>
				)}
				{authMessage && (
					<p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
						{authMessage}
					</p>
				)}
				{verifiedEmail && (
					<p className="mt-2 text-sm font-medium text-green-700">
						Verified Google email: {verifiedEmail}
					</p>
				)}
			</section>

			<main className="flex-1 flex flex-col lg:flex-row overflow-hidden relative z-10">
				<div className="w-full lg:w-[60%] overflow-hidden px-6 pb-6">
					<CodeDisplay
						currentStep={workflowState.currentStep}
						workflowStatus={workflowState.workflowStatus}
						onStartWorkflow={handleStartWorkflow}
						isStarting={isStarting}
					/>
				</div>

				<div className="flex-1 overflow-hidden px-6 lg:pl-8 lg:pr-6 pb-6">
					<WorkflowDiagram
						steps={WORKFLOW_STEPS}
						stepStatuses={workflowState.stepStatuses}
						currentStep={workflowState.currentStep}
						instanceId={instanceId}
						workflowStatus={workflowState.workflowStatus}
						onStartWorkflow={handleStartWorkflow}
						isStarting={isStarting}
					/>
				</div>
			</main>
		</div>
	);
}

export default App;
