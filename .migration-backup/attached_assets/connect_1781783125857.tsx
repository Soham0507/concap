import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Plug,
  Plus,
  Copy,
  Check,
  Trash2,
  KeyRound,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Terminal,
} from "lucide-react";

interface AccessToken {
  id: number;
  name: string;
  tokenPrefix: string | null;
  revoked: boolean;
  lastUsedAt: string | null;
  createdAt: string | null;
}

interface CreatedToken extends AccessToken {
  token: string;
}

const MCP_TOOLS = [
  { name: "list_projects", desc: "List your projects with status & progress." },
  { name: "get_project_tasks", desc: "Read the tasks inside a project." },
  {
    name: "search_evidence",
    desc: "Search your notes, files, meetings & insights.",
  },
  {
    name: "list_discoveries",
    desc: "List feature candidates with RICE scores.",
  },
  {
    name: "query_beliefs",
    desc: "Look up consolidated, attributed claims.",
  },
  {
    name: "search_my_context",
    desc: "Hybrid retrieval across everything you've captured.",
  },
];

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      data-testid="button-copy"
    >
      {copied ? (
        <Check className="h-4 w-4" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
      {label ? <span className="ml-2">{copied ? "Copied" : label}</span> : null}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="bg-slate-950 text-slate-100 text-xs rounded-lg p-4 overflow-x-auto">
        <code>{code}</code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

export default function ConnectPage() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);

  const mcpUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/mcp`
      : "https://your-app.example.com/api/mcp";

  const { data: tokens = [], isLoading } = useQuery<AccessToken[]>({
    queryKey: ["/api/mcp/tokens"],
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) =>
      apiRequest("/api/mcp/tokens", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (data: CreatedToken) => {
      setCreatedToken(data);
      setCreateOpen(false);
      setNewName("");
      queryClient.invalidateQueries({ queryKey: ["/api/mcp/tokens"] });
    },
    onError: () => {
      toast({
        title: "Could not create token",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: number) =>
      apiRequest(`/api/mcp/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Token revoked" });
      queryClient.invalidateQueries({ queryKey: ["/api/mcp/tokens"] });
    },
    onError: () => {
      toast({
        title: "Could not revoke token",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const tokenForConfig = createdToken?.token ?? "<YOUR_TOKEN>";

  const claudeConfig = `{
  "mcpServers": {
    "requisor": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${mcpUrl}",
        "--header",
        "Authorization: Bearer ${tokenForConfig}"
      ]
    }
  }
}`;

  const cursorConfig = `{
  "mcpServers": {
    "requisor": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer ${tokenForConfig}"
      }
    }
  }
}`;

  const genericConfig = `POST ${mcpUrl}
Content-Type: application/json
Authorization: Bearer ${tokenForConfig}

# Transport: MCP Streamable HTTP (JSON-RPC 2.0)
# Example initialize request body:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "my-client", "version": "1.0.0" }
  }
}`;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-emerald-100 text-emerald-700 p-2.5">
            <Plug className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Connect Requisor to AI tools
            </h1>
            <p className="text-slate-500 mt-1 max-w-2xl">
              Requisor speaks the Model Context Protocol (MCP). Connect Claude
              Desktop, Cursor, or any MCP client and let it read your projects,
              tasks, evidence, discoveries and context — securely and
              read-only.
            </p>
          </div>
        </div>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Read-only & scoped to you</AlertTitle>
        <AlertDescription>
          Connected tools can only read your own data. They cannot create,
          edit, or delete anything. Access is authenticated with a personal
          token you can revoke at any time.
        </AlertDescription>
      </Alert>

      {/* Step 1 — create a token */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> 1. Create an access token
          </CardTitle>
          <CardDescription>
            Each MCP client needs a personal access token. The token is shown
            once — copy it somewhere safe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={() => setCreateOpen(true)}
            data-testid="button-new-token"
          >
            <Plus className="h-4 w-4 mr-2" /> New token
          </Button>

          {isLoading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading tokens…
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-slate-500">
              You don't have any tokens yet.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {tokens.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-4 p-3"
                  data-testid={`row-token-${t.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{t.name}</span>
                      {t.revoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      <code>{t.tokenPrefix ?? "rqsr_"}…</code>
                      {t.lastUsedAt
                        ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </div>
                  </div>
                  {!t.revoked && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeMutation.mutate(t.id)}
                      disabled={revokeMutation.isPending}
                      data-testid={`button-revoke-${t.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2 — configure clients */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" /> 2. Add Requisor to your client
          </CardTitle>
          <CardDescription>
            Copy the config below. Replace{" "}
            <code>&lt;YOUR_TOKEN&gt;</code> with the token you created (or
            create one first and it will be filled in automatically).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Server URL:</span>
            <code className="bg-slate-100 rounded px-2 py-0.5">{mcpUrl}</code>
            <CopyButton value={mcpUrl} />
          </div>

          <Tabs defaultValue="claude">
            <TabsList>
              <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
              <TabsTrigger value="cursor">Cursor</TabsTrigger>
              <TabsTrigger value="generic">Generic / HTTP</TabsTrigger>
            </TabsList>
            <TabsContent value="claude" className="space-y-2">
              <p className="text-sm text-slate-500">
                Add this to your{" "}
                <code>claude_desktop_config.json</code> (Settings → Developer →
                Edit Config), then restart Claude Desktop.
              </p>
              <CodeBlock code={claudeConfig} />
            </TabsContent>
            <TabsContent value="cursor" className="space-y-2">
              <p className="text-sm text-slate-500">
                Add this to <code>~/.cursor/mcp.json</code> (or
                Settings → MCP → Add server).
              </p>
              <CodeBlock code={cursorConfig} />
            </TabsContent>
            <TabsContent value="generic" className="space-y-2">
              <p className="text-sm text-slate-500">
                Any MCP client that supports the Streamable HTTP transport can
                connect by POSTing JSON-RPC to the URL with a Bearer token.
              </p>
              <CodeBlock code={genericConfig} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Step 3 — what it can do */}
      <Card>
        <CardHeader>
          <CardTitle>3. What your AI can now do</CardTitle>
          <CardDescription>
            These read-only tools become available to the connected client.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-3">
            {MCP_TOOLS.map((tool) => (
              <div
                key={tool.name}
                className="rounded-lg border p-3"
                data-testid={`tool-${tool.name}`}
              >
                <code className="text-sm font-semibold text-emerald-700">
                  {tool.name}
                </code>
                <p className="text-sm text-slate-500 mt-1">{tool.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Create token dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create access token</DialogTitle>
            <DialogDescription>
              Give it a name so you remember where it's used (e.g. "Claude on my
              laptop").
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Claude Desktop"
              maxLength={100}
              data-testid="input-token-name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(newName.trim() || "MCP token")}
              disabled={createMutation.isPending}
              data-testid="button-create-token"
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal-once dialog */}
      <Dialog
        open={!!createdToken}
        onOpenChange={(open) => !open && setCreatedToken(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your token now</DialogTitle>
            <DialogDescription>
              This is the only time the full token is shown. If you lose it,
              revoke it and create a new one.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Treat this like a password</AlertTitle>
            <AlertDescription>
              Anyone with this token can read your Requisor data.
            </AlertDescription>
          </Alert>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-slate-100 rounded px-3 py-2 text-sm break-all">
              {createdToken?.token}
            </code>
            {createdToken && (
              <CopyButton value={createdToken.token} label="Copy" />
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
