import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
  varchar,
  index,
  unique,
  primaryKey,
  date,
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// Session storage table for Replit Auth
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid", { length: 255 }).primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// Subscription Plans schema
export const subscriptionPlans = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // "Free", "Pro", "Business", "Enterprise"
  slug: text("slug").notNull().unique(), // "free", "pro", "business", "enterprise"
  description: text("description"),
  price: integer("price").notNull().default(0), // in cents, $0 for free
  currency: text("currency").default("USD"),
  billingInterval: text("billing_interval").default("month"), // "month", "year", "one_time"
  features: text("features").array().notNull().default([]), // array of feature slugs
  maxUsers: integer("max_users").default(1), // number of users allowed
  maxProjects: integer("max_projects").default(10), // number of projects allowed
  monthlyTokenLimit: integer("monthly_token_limit").default(25000), // monthly AI token budget
  stripeProductId: text("stripe_product_id"), // Stripe product ID
  stripePriceId: text("stripe_price_id"), // Stripe price ID
  isActive: boolean("is_active").default(true),
  sortOrder: integer("sort_order").default(0), // for display ordering
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Feature Definitions schema
export const features = pgTable("features", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // "Basic AI agent", "Smart suggestions", etc.
  slug: text("slug").notNull().unique(), // "basic_ai", "smart_suggestions", etc.
  description: text("description"),
  category: text("category").notNull(), // "ai", "collaboration", "integrations", "export", etc.
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Password Reset Tokens schema
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  token: varchar("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
});

// Email Verification Tokens schema
export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  token: varchar("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
});

// Personal Access Tokens schema — used to authenticate external MCP clients
// (Claude Desktop, Cursor, etc.) since they cannot use session-based OIDC.
// Only a SHA-256 hash of the token is stored; the plaintext is shown once.
export const personalAccessTokens = pgTable("personal_access_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: varchar("token_hash").notNull().unique(),
  // First few chars of the plaintext (e.g. "rqsr_ab12") for display only.
  tokenPrefix: varchar("token_prefix"),
  lastUsedAt: timestamp("last_used_at"),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPersonalAccessTokenSchema = createInsertSchema(
  personalAccessTokens,
).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
  revoked: true,
});
export type InsertPersonalAccessToken = z.infer<
  typeof insertPersonalAccessTokenSchema
>;
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;

// Users schema
export const users = pgTable("users", {
  id: varchar("id").primaryKey().notNull(),
  username: varchar("username").unique().notNull(),
  email: varchar("email").unique(),
  password: varchar("password"), // For custom authentication
  emailVerified: boolean("email_verified").default(false), // Email verification status
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  bio: text("bio"),
  profileImageUrl: varchar("profile_image_url"),
  planId: integer("plan_id")
    .references(() => subscriptionPlans.id)
    .default(1), // Default to Free plan
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status").default("active"), // "active", "canceled", "past_due", "unpaid"
  subscriptionEndDate: timestamp("subscription_end_date"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Projects schema
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  dueDate: timestamp("due_date"),
  status: text("status").default("active"),
  progress: integer("progress").default(0),
  totalTasks: integer("total_tasks").default(0),
  completedTasks: integer("completed_tasks").default(0),
  icon: text("icon").default("folder-open"),
  iconBg: text("icon_bg").default("blue"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  lastOpenedAt: timestamp("last_opened_at"),
  ownerId: varchar("owner_id").references(() => users.id),
  externalId: text("external_id"),
  source: text("source").default("manual"), // "manual", "smartsheet", "jira", etc.
  sourceData: jsonb("source_data"),
  aiGenerated: boolean("ai_generated").default(false),
});

// Project Members schema - defines user access to projects
export const projectMembers = pgTable(
  "project_members",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"), // "owner", "editor", "viewer"
    addedAt: timestamp("added_at").defaultNow(),
  },
  (table) => {
    return {
      // Unique constraint to prevent duplicate memberships
      uniqueProjectUser: unique().on(table.projectId, table.userId),
    };
  },
);

// Project Invitations schema - for email invitations
export const projectInvitations = pgTable("project_invitations", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("viewer"), // "owner", "editor", "viewer"
  token: text("token").notNull(), // Unique token for accepting invitation
  status: text("status").notNull().default("pending"), // "pending", "accepted", "declined"
  invitedBy: varchar("invited_by")
    .notNull()
    .references(() => users.id), // User who sent the invitation
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at"), // When the invitation expires
  acceptedAt: timestamp("accepted_at"),
});

// Tasks schema
export const tasks: any = pgTable("tasks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").default("todo"), // "todo", "in-progress", "done"
  isCompleted: boolean("is_completed").default(false),
  dueDate: timestamp("due_date"),
  priority: text("priority").default("medium"), // "low", "medium", "high"
  assigneeId: varchar("assignee_id").references(() => users.id),
  projectId: integer("project_id").references(() => projects.id),
  parentTaskId: integer("parent_task_id").references((): any => tasks.id, {
    onDelete: "cascade",
  }),
  isSubtask: boolean("is_subtask").default(false),
  completedSubtasks: integer("completed_subtasks").default(0),
  totalSubtasks: integer("total_subtasks").default(0),
  position: integer("position").default(0), // Position within parent or project
  externalId: text("external_id"),
  source: text("source").default("manual"), // "manual", "smartsheet", "jira", "asana", "monday"
  sourceData: jsonb("source_data"), // Additional data from external systems
  lastSynced: timestamp("last_synced"), // Last time this task was synced with external system
  createdAt: timestamp("created_at").defaultNow(),
  icon: text("icon"),
  progress: integer("progress").default(0),
  aiGenerated: boolean("ai_generated").default(false),
  storyPoints: integer("storypoints"),
});

// Task Comments schema
export const taskComments: any = pgTable("task_comments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  content: text("content").notNull(),
  parentCommentId: integer("parent_comment_id").references(
    (): any => taskComments.id,
    { onDelete: "cascade" },
  ),
  isEdited: boolean("is_edited").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// RGA Task Categories
export const rgaCategories = pgTable("rga_categories", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .references(() => tasks.id)
    .notNull(),
  category: text("category").notNull(), // 'rga', 'non-rga', 'strategic'
  confidence: integer("confidence").default(85), // AI confidence score
  reasoning: text("reasoning"), // AI explanation
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// RGA Team Settings
export const rgaSettings = pgTable("rga_settings", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  mode: text("mode").default("pre-funding"), // 'pre-funding' or 'post-funding'
  targetRgaPercentage: integer("target_rga_percentage").default(40),
  revenueChannel: text("revenue_channel"),
  nextMilestone: timestamp("next_milestone"),
  weeklyCustomerHours: integer("weekly_customer_hours").default(20),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// RGA Weekly Reports
export const rgaReports = pgTable("rga_reports", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  weekStarting: timestamp("week_starting").notNull(),
  rgaPercentage: integer("rga_percentage"),
  nonRgaPercentage: integer("non_rga_percentage"),
  strategicPercentage: integer("strategic_percentage"),
  totalHours: integer("total_hours"),
  recommendations: text("recommendations").array(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Task File Attachments schema
export const taskAttachments = pgTable("task_attachments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  fileType: text("file_type").notNull(), // "pdf", "image", "document", "other"
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size").notNull(), // in bytes
  uploadPath: text("upload_path").notNull(), // local file path or storage URL
  createdAt: timestamp("created_at").defaultNow(),
});

// Integrations schema
export const integrations = pgTable("integrations", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  provider: text("provider").notNull(), // "smartsheet", "jira", "asana", "monday"
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  isConnected: boolean("is_connected").default(false),
  lastSynced: timestamp("last_synced"),
  workspaceId: text("workspace_id"),
  additionalData: jsonb("additional_data"),
});

// Task Mappings schema - tracks relationships between Requisor tasks and external systems
export const taskMappings = pgTable("task_mappings", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").references(() => tasks.id, {
    onDelete: "cascade",
  }),
  externalId: text("external_id").notNull(),
  provider: text("provider").notNull(), // "smartsheet", "jira", "asana", "monday"
  lastSynced: timestamp("last_synced").defaultNow(),
  mappedFields: jsonb("mapped_fields"), // Stores field mappings between systems
});

// Kanban Board Columns schema
export const kanbanColumns = pgTable("kanban_columns", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  title: text("title").notNull(),
  status: text("status").notNull(), // Value used for task status
  color: text("color").default("bg-slate-100"),
  iconName: text("icon_name").default("circle"),
  order: integer("position").default(0), // Using 'position' column name in DB but 'order' in code
  createdAt: timestamp("created_at").defaultNow(),
});

// AI Insights schema
/**
 * @deprecated Task #99 — `insights` is the v1 "single-shot AI observation"
 * table. New work should write durable claims into the `beliefs` table below,
 * which carries attribution, weight, source links, decay, and contradiction
 * tracking. We dual-read both surfaces during the transition; a follow-up
 * task will migrate existing `insights` rows into `beliefs` and drop this.
 */
export const insights = pgTable("insights", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // "bottleneck", "resource-conflict", "timeline-risk", etc.
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").default("info"), // "info", "warning", "critical"
  projectId: integer("project_id").references(() => projects.id),
  createdAt: timestamp("created_at").defaultNow(),
  isResolved: boolean("is_resolved").default(false),
  resolvedAt: timestamp("resolved_at"),
  suggestedAction: text("suggested_action"),
});

// AI Tools schema
export const aiTools = pgTable("ai_tools", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  freePlanAvailable: boolean("free_plan_available").default(false),
  pricing: text("pricing"),
  website: text("website").notNull(),
  logoUrl: text("logo_url"),
  useCase: text("use_case"),
  idealFor: text("ideal_for"),
});

// AI Agents schema - for user-created AI assistants that can be assigned tasks
export const aiAgents = pgTable("ai_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  agentType: text("agent_type").notNull(), // "planning", "analysis", "content", "workflow", "custom"
  capabilities: text("capabilities").array().notNull(), // Array of capabilities like ["task_management", "content_creation"]
  instructions: text("instructions"), // Custom instructions for the AI agent
  model: text("model").default("gpt-4o"), // AI model to use
  temperature: integer("temperature").default(70), // AI creativity level (0-100)
  maxTokens: integer("max_tokens").default(2000), // Response length limit
  isActive: boolean("is_active").default(true),
  isPublic: boolean("is_public").default(false), // Whether other users can see/use this agent
  createdBy: varchar("created_by")
    .notNull()
    .references(() => users.id),
  projectId: integer("project_id").references(() => projects.id), // Optional project-specific agent
  avatar: text("avatar").default("🤖"), // Emoji or icon for the agent
  color: text("color").default("#3b82f6"), // Color theme for the agent
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Task Tool Recommendations schema
export const taskToolRecommendations = pgTable(
  "task_tool_recommendations",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    toolId: integer("tool_id")
      .notNull()
      .references(() => aiTools.id, { onDelete: "cascade" }),
    status: text("status").default("suggested"), // "suggested", "saved", "ignored", "used"
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => {
    return {
      unq: unique().on(table.taskId, table.toolId),
    };
  },
);

// AI Prompts table to store user prompts for training
export const aiPrompts = pgTable("ai_prompts", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  prompt: text("prompt").notNull(), // The original user prompt
  promptType: text("prompt_type").notNull(), // "project_generation", "task_analysis", "tool_recommendation"
  response: jsonb("response"), // The AI response/output
  projectId: integer("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }), // Associated project if applicable
  taskId: integer("task_id").references(() => tasks.id, {
    onDelete: "cascade",
  }), // Associated task if applicable
  feedback: text("feedback"), // User feedback on the AI response
  rating: integer("rating"), // User rating 1-5
  usedResponse: boolean("used_response").default(false), // Whether user actually used the AI response
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Chat sessions for persistent agent conversations
export const chatSessions = pgTable("chat_sessions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: integer("project_id"),
  sessionId: text("session_id").notNull().unique(),
  title: text("title"),
  mode: text("mode").default("plan"), // 'plan' or 'build' — distinguishes Plan/Build conversations
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Individual chat messages
export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(), // 'user' or 'assistant'
  content: text("content").notNull(),
  insights: text("insights"), // JSON string
  actions: text("actions"), // JSON string
  suggestedPrompts: text("suggested_prompts"), // JSON string
  citations: text("citations"), // JSON string of Citation[] (Task #94 reload support)
  createdAt: timestamp("created_at").defaultNow(),
});

// Create vector type for Drizzle (custom type as native 'vector' might not be in all pg-core versions yet)
import { customType } from "drizzle-orm/pg-core";
const vector = customType<{ data: number[] }>({
  dataType() {
    return "vector(768)";
  },
});

// Chat Embeddings schema for RAG/Memory
export const chatEmbeddings = pgTable("chat_embeddings", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  embedding: vector("embedding"),
  metadata: jsonb("metadata"), // { sessionId, role, timestamp }
  createdAt: timestamp("created_at").defaultNow(),
});

// Feature Candidates schema - Build Mode discoveries
export const featureCandidates = pgTable("feature_candidates", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  featureTitle: text("feature_title").notNull(),
  whyNow: text("why_now"),
  evidence: text("evidence").array().default([]),
  evidenceItemIds: integer("evidence_item_ids").array().default([]),
  evidenceQuotes: text("evidence_quotes").array().default([]),
  sourceConversationIds: integer("source_conversation_ids").array().default([]),
  sourceConversationQuotes: text("source_conversation_quotes").array().default([]),
  sourceSessionId: text("source_session_id"), // chat_sessions.sessionId of the Build conversation that produced this

  uiChanges: text("ui_changes"),
  dataModelChanges: text("data_model_changes"),
  workflowChanges: text("workflow_changes"),
  tasks: jsonb("tasks").default([]),
  insights: jsonb("insights").default([]),
  reasoningChain: text("reasoning_chain"),
  status: text("status").default("candidate"),
  sourceContext: text("source_context"),
  approvedAt: timestamp("approved_at"),
  projectId: integer("project_id").references(() => projects.id),
  impactScore: integer("impact_score"),
  effortScore: integer("effort_score"),
  confidenceScore: integer("confidence_score"),
  riceScore: integer("rice_score"),
  priorityRank: integer("priority_rank"),
  scoreReasoning: jsonb("score_reasoning"),
  lastSentToAgent: text("last_sent_to_agent"),
  lastSentAt: timestamp("last_sent_at"),
  mentionCount: integer("mention_count").default(1),
  source: text("source").default("ai"),
  createdBy: varchar("created_by").references(() => users.id),
  tags: text("tags").array().default([]),
  mergedIntoId: integer("merged_into_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertFeatureCandidateSchema = createInsertSchema(
  featureCandidates,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
});

export const manualFeatureCandidateSchema = z.object({
  featureTitle: z.string().min(1, "Title is required").max(200),
  whyNow: z.string().max(2000).optional().nullable(),
  sourceContext: z.string().max(2000).optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  evidenceItemIds: z.array(z.number().int().positive()).optional(),
  evidenceQuotes: z.array(z.string().max(2000)).max(50).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
export type ManualFeatureCandidateInput = z.infer<
  typeof manualFeatureCandidateSchema
>;
export type InsertFeatureCandidate = z.infer<
  typeof insertFeatureCandidateSchema
>;
export type FeatureCandidate = typeof featureCandidates.$inferSelect;

// Project plans from AI agent
export const projectPlans = pgTable("project_plans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  sessionId: text("session_id"),
  planData: text("plan_data").notNull(), // JSON string
  isSaved: boolean("is_saved").default(false),
  projectId: integer("project_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Budget Estimates schema
export const budgetEstimates = pgTable("budget_estimates", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").default("draft"), // "draft", "approved", "sent"
  totalAmount: integer("total_amount").default(0), // in cents
  currency: text("currency").default("USD"),
  clientName: text("client_name"),
  clientEmail: text("client_email"),
  clientCompany: text("client_company"),
  validUntil: timestamp("valid_until"),
  terms: text("terms"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Budget Line Items schema
export const budgetLineItems = pgTable("budget_line_items", {
  id: serial("id").primaryKey(),
  budgetId: integer("budget_id")
    .notNull()
    .references(() => budgetEstimates.id, { onDelete: "cascade" }),
  taskId: integer("task_id").references(() => tasks.id),
  category: text("category").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").default(1),
  rate: integer("rate").notNull(), // hourly rate in cents
  hours: integer("hours").default(0), // estimated hours
  totalAmount: integer("total_amount").notNull(), // in cents
  role: text("role"), // "developer", "designer", "manager", etc.
  position: integer("position").default(0),
});

// Rate Templates schema
export const rateTemplates = pgTable("rate_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  hourlyRate: integer("hourly_rate").notNull(), // in cents
  currency: text("currency").default("USD"),
  isActive: boolean("is_active").default(true),
  userId: varchar("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// Onboarding Plans schema
export const onboardingPlans = pgTable("onboarding_plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(), // "employee", "client", "contractor"
  role: text("role"), // specific role/department
  duration: integer("duration").default(7), // duration in days
  status: text("status").default("draft"), // "draft", "active", "archived"
  isTemplate: boolean("is_template").default(false),
  templateFor: text("template_for"), // role/department this template is for
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Onboarding Steps schema
export const onboardingSteps = pgTable("onboarding_steps", {
  id: serial("id").primaryKey(),
  planId: integer("plan_id")
    .notNull()
    .references(() => onboardingPlans.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(), // "welcome", "tools", "culture", "tasks", "goals", "feedback"
  dayNumber: integer("day_number").notNull(), // which day this step occurs
  order: integer("step_order").default(0), // order within the day
  assignedTo: text("assigned_to"), // "ai", "manager", "buddy", "hr"
  isRequired: boolean("is_required").default(true),
  estimatedTime: integer("estimated_time"), // estimated time in minutes
  resources: jsonb("resources"), // links, documents, videos
  completionCriteria: text("completion_criteria"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Onboarding Instances schema (actual onboarding sessions)
export const onboardingInstances = pgTable("onboarding_instances", {
  id: serial("id").primaryKey(),
  planId: integer("plan_id")
    .notNull()
    .references(() => onboardingPlans.id),
  onboardeeId: varchar("onboardee_id").references(() => users.id), // person being onboarded
  onboardeeName: text("onboardee_name").notNull(),
  onboardeeEmail: text("onboardee_email").notNull(),
  managerId: varchar("manager_id").references(() => users.id), // manager/HR person
  status: text("status").default("not_started"), // "not_started", "in_progress", "completed", "paused"
  startDate: timestamp("start_date"),
  expectedEndDate: timestamp("expected_end_date"),
  actualEndDate: timestamp("actual_end_date"),
  completionRate: integer("completion_rate").default(0), // percentage completed
  currentDay: integer("current_day").default(1),
  personalizedData: jsonb("personalized_data"), // custom fields, preferences
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Onboarding Step Completions schema
export const onboardingStepCompletions = pgTable(
  "onboarding_step_completions",
  {
    id: serial("id").primaryKey(),
    instanceId: integer("instance_id")
      .notNull()
      .references(() => onboardingInstances.id, { onDelete: "cascade" }),
    stepId: integer("step_id")
      .notNull()
      .references(() => onboardingSteps.id, { onDelete: "cascade" }),
    status: text("status").default("pending"), // "pending", "in_progress", "completed", "skipped"
    completedAt: timestamp("completed_at"),
    completedBy: varchar("completed_by").references(() => users.id),
    notes: text("notes"),
    feedback: text("feedback"),
    rating: integer("rating"), // 1-5 rating for the step
    timeSpent: integer("time_spent"), // actual time spent in minutes
  },
  (table) => {
    return {
      unq: unique().on(table.instanceId, table.stepId),
    };
  },
);

// Team Members schema for bandwidth management
export const teamMembers = pgTable("team_members", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  avatar: text("avatar"),
  bio: text("bio"),
  department: text("department"),
  skills: text("skills").array(), // Array of skills
  capacity: integer("capacity").default(40), // hours per week
  allocated: integer("allocated").default(0), // currently allocated hours
  availability: integer("availability").default(100), // percentage available
  performance: integer("performance").default(90), // 0-100 score
  hourlyRate: integer("hourly_rate").default(5000), // hourly rate in cents
  timezone: text("timezone").default("UTC"),
  workingHours: text("working_hours").default("9:00-17:00"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Smart Task Assignments schema
export const smartTaskAssignments = pgTable("smart_task_assignments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  teamMemberId: integer("team_member_id").references(() => teamMembers.id),
  assignmentType: text("assignment_type").notNull(), // "human", "ai", "hybrid"
  confidence: integer("confidence").default(0), // 0-100
  reasoning: text("reasoning"),
  estimatedCompletion: text("estimated_completion"),
  costSavings: integer("cost_savings").default(0), // in cents
  aiSuitable: boolean("ai_suitable").default(false),
  humanRequired: boolean("human_required").default(false),
  complexity: text("complexity").default("medium"), // "low", "medium", "high"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Capacity Alerts schema
export const capacityAlerts = pgTable("capacity_alerts", {
  id: serial("id").primaryKey(),
  teamMemberId: integer("team_member_id").references(() => teamMembers.id),
  alertType: text("alert_type").notNull(), // "overload", "underutilized", "skill_gap"
  severity: text("severity").default("medium"), // "low", "medium", "high"
  message: text("message").notNull(),
  threshold: integer("threshold"), // percentage threshold that triggered alert
  currentValue: integer("current_value"), // current percentage value
  isResolved: boolean("is_resolved").default(false),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Onboarding Templates schema (pre-built templates)
export const onboardingTemplates = pgTable("onboarding_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(), // "employee", "client", "contractor"
  department: text("department"), // "engineering", "marketing", "sales", etc.
  role: text("role"), // specific role
  isPublic: boolean("is_public").default(false), // can be used by others
  templateData: jsonb("template_data").notNull(), // complete template structure
  usageCount: integer("usage_count").default(0),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Task Priority Scores schema - AI-generated priority analysis
export const taskPriorityScores = pgTable(
  "task_priority_scores",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    priorityScore: integer("priority_score").notNull(), // 1-10 AI priority score (stored as 1-100 for decimal precision)
    roiLevel: text("roi_level").notNull(), // "high", "medium", "low"
    effortLevel: text("effort_level").notNull(), // "high", "medium", "low"
    urgencyLevel: text("urgency_level").notNull(), // "high", "medium", "low"
    strategicFit: text("strategic_fit").notNull(), // "high", "medium", "low"
    recommendation: text("recommendation").notNull(), // AI recommendation text
    confidence: integer("confidence").default(85), // AI confidence score 0-100
    weightingProfile: text("weighting_profile").default("balanced"), // "speed", "roi", "balanced"
    analysisData: jsonb("analysis_data"), // Detailed AI analysis data
    generatedBy: varchar("generated_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => {
    return {
      unq: unique().on(table.taskId), // One priority score per task
    };
  },
);

// Priority Weighting Preferences schema - User preferences for prioritization
export const priorityWeightingPreferences = pgTable(
  "priority_weighting_preferences",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id),
    projectId: integer("project_id").references(() => projects.id), // Project-specific or global if null
    roiWeight: integer("roi_weight").default(25), // 0-100 percentage
    effortWeight: integer("effort_weight").default(25), // 0-100 percentage
    urgencyWeight: integer("urgency_weight").default(25), // 0-100 percentage
    strategicWeight: integer("strategic_weight").default(25), // 0-100 percentage
    profileName: text("profile_name").default("Balanced"), // "Speed Focused", "ROI Focused", "Balanced"
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
);

// Insert schemas
export const insertUserSchema = createInsertSchema(users);
export const insertProjectSchema = createInsertSchema(projects)
  .omit({
    id: true,
    createdAt: true,
    dueDate: true, // Remove auto-generated dueDate validation
  })
  .extend({
    dueDate: z.string().optional().nullable(), // Accept ISO date strings directly
  });
export const insertTaskSchema = createInsertSchema(tasks)
  .omit({ id: true, createdAt: true })
  .extend({
    description: z.string().optional(),
    status: z.string().default("todo"),
    priority: z.string().optional(),
    assigneeId: z.string().nullish(), // Allow null values
    projectId: z.number().optional(),
    parentTaskId: z.number().nullish(), // Allow null values
    isSubtask: z.boolean().default(false),
    completedSubtasks: z.number().default(0),
    dueDate: z
      .union([z.date(), z.string().transform((str) => new Date(str))])
      .optional(), // Accept both Date objects and ISO strings
    totalSubtasks: z.number().default(0),
    position: z.number().default(0),
  });
export const insertIntegrationSchema = createInsertSchema(integrations).omit({
  id: true,
  lastSynced: true,
});
export const insertInsightSchema = createInsertSchema(insights).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});
export const insertProjectMemberSchema = createInsertSchema(
  projectMembers,
).omit({ id: true, addedAt: true });
export const insertProjectInvitationSchema = createInsertSchema(
  projectInvitations,
).omit({ id: true, createdAt: true, acceptedAt: true });
export const insertKanbanColumnSchema = createInsertSchema(kanbanColumns).omit({
  id: true,
  createdAt: true,
});
export const insertAiToolSchema = createInsertSchema(aiTools).omit({
  id: true,
});
export const insertTaskToolRecommendationSchema = createInsertSchema(
  taskToolRecommendations,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAiPromptSchema = createInsertSchema(aiPrompts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
});
export const insertProjectPlanSchema = createInsertSchema(projectPlans).omit({
  id: true,
  createdAt: true,
});
export const insertBudgetEstimateSchema = createInsertSchema(
  budgetEstimates,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBudgetLineItemSchema = createInsertSchema(
  budgetLineItems,
).omit({ id: true });
export const insertRateTemplateSchema = createInsertSchema(rateTemplates).omit({
  id: true,
  createdAt: true,
});
export const insertOnboardingPlanSchema = createInsertSchema(
  onboardingPlans,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertOnboardingStepSchema = createInsertSchema(
  onboardingSteps,
).omit({ id: true, createdAt: true });
export const insertOnboardingInstanceSchema = createInsertSchema(
  onboardingInstances,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertOnboardingStepCompletionSchema = createInsertSchema(
  onboardingStepCompletions,
).omit({ id: true });
export const insertOnboardingTemplateSchema = createInsertSchema(
  onboardingTemplates,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTaskPriorityScoreSchema = createInsertSchema(
  taskPriorityScores,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPriorityWeightingPreferenceSchema = createInsertSchema(
  priorityWeightingPreferences,
).omit({ id: true, createdAt: true, updatedAt: true });

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export type InsertIntegration = z.infer<typeof insertIntegrationSchema>;
export type Integration = typeof integrations.$inferSelect;

// Create insert schema for task mappings
export const insertTaskMappingSchema = createInsertSchema(taskMappings).omit({
  id: true,
  lastSynced: true,
});
export type InsertTaskMapping = z.infer<typeof insertTaskMappingSchema>;
export type TaskMapping = typeof taskMappings.$inferSelect;

export type InsertInsight = z.infer<typeof insertInsightSchema>;
export type Insight = typeof insights.$inferSelect;

export type InsertProjectMember = z.infer<typeof insertProjectMemberSchema>;
export type ProjectMember = typeof projectMembers.$inferSelect;

export type InsertProjectInvitation = z.infer<
  typeof insertProjectInvitationSchema
>;
export type ProjectInvitation = typeof projectInvitations.$inferSelect;

export type InsertKanbanColumn = z.infer<typeof insertKanbanColumnSchema>;
export type KanbanColumn = typeof kanbanColumns.$inferSelect;

export type InsertAiTool = z.infer<typeof insertAiToolSchema>;
export type AiTool = typeof aiTools.$inferSelect;

export type InsertTaskToolRecommendation = z.infer<
  typeof insertTaskToolRecommendationSchema
>;
export type TaskToolRecommendation =
  typeof taskToolRecommendations.$inferSelect;

export type InsertAiPrompt = z.infer<typeof insertAiPromptSchema>;
export type AiPrompt = typeof aiPrompts.$inferSelect;

export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type ChatSession = typeof chatSessions.$inferSelect;

export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

export type InsertProjectPlan = z.infer<typeof insertProjectPlanSchema>;
export type ProjectPlan = typeof projectPlans.$inferSelect;

export type InsertBudgetEstimate = z.infer<typeof insertBudgetEstimateSchema>;
export type BudgetEstimate = typeof budgetEstimates.$inferSelect;

export type InsertBudgetLineItem = z.infer<typeof insertBudgetLineItemSchema>;
export type BudgetLineItem = typeof budgetLineItems.$inferSelect;

export type InsertTaskPriorityScore = z.infer<
  typeof insertTaskPriorityScoreSchema
>;
export type TaskPriorityScore = typeof taskPriorityScores.$inferSelect;

export type InsertPriorityWeightingPreference = z.infer<
  typeof insertPriorityWeightingPreferenceSchema
>;
export type PriorityWeightingPreference =
  typeof priorityWeightingPreferences.$inferSelect;

export type InsertRateTemplate = z.infer<typeof insertRateTemplateSchema>;
export type RateTemplate = typeof rateTemplates.$inferSelect;

export type InsertOnboardingPlan = z.infer<typeof insertOnboardingPlanSchema>;
export type OnboardingPlan = typeof onboardingPlans.$inferSelect;

export type InsertOnboardingStep = z.infer<typeof insertOnboardingStepSchema>;
export type OnboardingStep = typeof onboardingSteps.$inferSelect;

export type InsertOnboardingInstance = z.infer<
  typeof insertOnboardingInstanceSchema
>;
export type OnboardingInstance = typeof onboardingInstances.$inferSelect;

export type InsertOnboardingStepCompletion = z.infer<
  typeof insertOnboardingStepCompletionSchema
>;
export type OnboardingStepCompletion =
  typeof onboardingStepCompletions.$inferSelect;

export type InsertOnboardingTemplate = z.infer<
  typeof insertOnboardingTemplateSchema
>;
export type OnboardingTemplate = typeof onboardingTemplates.$inferSelect;

// Team Member schemas
export const insertTeamMemberSchema = createInsertSchema(teamMembers);
export type InsertTeamMember = z.infer<typeof insertTeamMemberSchema>;
export type TeamMember = typeof teamMembers.$inferSelect;

// Smart Task Assignment schemas
export const insertSmartTaskAssignmentSchema =
  createInsertSchema(smartTaskAssignments);
export type InsertSmartTaskAssignment = z.infer<
  typeof insertSmartTaskAssignmentSchema
>;
export type SmartTaskAssignment = typeof smartTaskAssignments.$inferSelect;

// Capacity Alert schemas
export const insertCapacityAlertSchema = createInsertSchema(capacityAlerts);
export type InsertCapacityAlert = z.infer<typeof insertCapacityAlertSchema>;
export type CapacityAlert = typeof capacityAlerts.$inferSelect;

// Role enum for type safety
export enum ProjectRole {
  OWNER = "owner",
  EDITOR = "editor",
  VIEWER = "viewer",
}

// Tool status enum for type safety
export enum ToolStatus {
  SUGGESTED = "suggested",
  SAVED = "saved",
  IGNORED = "ignored",
  USED = "used",
}

// Team member profiles with capacity and skills
export const teamProfiles = pgTable("team_profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  skills: text("skills")
    .array()
    .default(sql`ARRAY[]::text[]`),
  weeklyCapacityHours: integer("weekly_capacity_hours").default(40),
  weeklyCapacityPoints: integer("weekly_capacity_points").default(20),
  currentUtilization: integer("current_utilization").default(0), // percentage
  timezone: text("timezone").default("UTC"),
  workingDays: text("working_days")
    .array()
    .default(sql`ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri']::text[]`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTeamProfileSchema = createInsertSchema(teamProfiles);
export type InsertTeamProfile = z.infer<typeof insertTeamProfileSchema>;
export type TeamProfile = typeof teamProfiles.$inferSelect;

// Team availability (PTO, holidays, etc)
export const teamAvailability = pgTable("team_availability", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  type: text("type").notNull().default("pto"), // pto, holiday, sick, other
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTeamAvailabilitySchema =
  createInsertSchema(teamAvailability);
export type InsertTeamAvailability = z.infer<
  typeof insertTeamAvailabilitySchema
>;
export type TeamAvailability = typeof teamAvailability.$inferSelect;

// Task assignments with effort tracking - supports both users and AI agents
export const taskAssignments = pgTable("task_assignments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, {
    onDelete: "cascade",
  }), // For user assignments
  aiAgentId: integer("ai_agent_id").references(() => aiAgents.id, {
    onDelete: "cascade",
  }), // For AI agent assignments
  assigneeType: text("assignee_type").notNull().default("user"), // "user" or "ai_agent"
  estimatedHours: integer("estimated_hours").default(0),
  estimatedPoints: integer("estimated_points").default(0),
  actualHours: integer("actual_hours").default(0),
  assignedAt: timestamp("assigned_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").default("assigned"), // "assigned", "in_progress", "completed", "failed"
  notes: text("notes"), // Any notes about the assignment
});

export const insertTaskAssignmentSchema = createInsertSchema(taskAssignments);
export type InsertTaskAssignment = z.infer<typeof insertTaskAssignmentSchema>;
export type TaskAssignment = typeof taskAssignments.$inferSelect;

// Task Comments types
export const insertTaskCommentSchema = createInsertSchema(taskComments);
export type InsertTaskComment = z.infer<typeof insertTaskCommentSchema>;
export type TaskComment = typeof taskComments.$inferSelect;

// Task Attachments types
export const insertTaskAttachmentSchema = createInsertSchema(taskAttachments);
export type InsertTaskAttachment = z.infer<typeof insertTaskAttachmentSchema>;
export type TaskAttachment = typeof taskAttachments.$inferSelect;

// RGA Categories types
export const insertRgaCategorySchema = createInsertSchema(rgaCategories);
export type InsertRgaCategory = z.infer<typeof insertRgaCategorySchema>;
export type RgaCategory = typeof rgaCategories.$inferSelect;

// RGA Settings types
export const insertRgaSettingsSchema = createInsertSchema(rgaSettings);
export type InsertRgaSettings = z.infer<typeof insertRgaSettingsSchema>;
export type RgaSettings = typeof rgaSettings.$inferSelect;

// RGA Reports types
export const insertRgaReportSchema = createInsertSchema(rgaReports);
export type InsertRgaReport = z.infer<typeof insertRgaReportSchema>;
export type RgaReport = typeof rgaReports.$inferSelect;

// JIRA Agent tables
export const jiraIntegrations = pgTable("jira_integrations", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  jiraUrl: text("jira_url").notNull(),
  email: text("email").notNull(),
  apiToken: text("api_token").notNull(),
  cloudId: text("cloud_id"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const userStories = pgTable("user_stories", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .references(() => projects.id)
    .notNull(),
  title: text("title").notNull(),
  story: text("story").notNull(),
  acceptanceCriteria: text("acceptance_criteria").array(),
  storyPoints: integer("story_points"),
  complexity: text("complexity"), // low, medium, high
  risk: text("risk"), // low, medium, high
  effort: text("effort"), // low, medium, high
  roiScore: integer("roi_score"),
  priority: text("priority"), // low, medium, high, critical
  jiraIssueKey: text("jira_issue_key"),
  jiraIssueId: text("jira_issue_id"),
  epicKey: text("epic_key"),
  sprintId: text("sprint_id"),
  assigneeId: varchar("assignee_id").references(() => users.id),
  status: text("status").default("todo"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const storyEstimations = pgTable("story_estimations", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id")
    .references(() => userStories.id)
    .notNull(),
  estimatedBy: varchar("estimated_by")
    .references(() => users.id)
    .notNull(),
  storyPoints: integer("story_points").notNull(),
  reasoning: text("reasoning"),
  factors: jsonb("factors"), // {complexity: 3, risk: 2, effort: 4, uncertainty: 1}
  createdAt: timestamp("created_at").defaultNow(),
});

export const jiraSyncLogs = pgTable("jira_sync_logs", {
  id: serial("id").primaryKey(),
  integrationId: integer("integration_id")
    .references(() => jiraIntegrations.id)
    .notNull(),
  syncType: text("sync_type").notNull(), // pull, push, update
  syncStatus: text("sync_status").notNull(), // success, failed, partial
  itemsSynced: integer("items_synced").default(0),
  errorMessage: text("error_message"),
  syncData: jsonb("sync_data"),
  createdAt: timestamp("created_at").defaultNow(),
});

// JIRA Integration types
export const insertJiraIntegrationSchema = createInsertSchema(jiraIntegrations);
export type InsertJiraIntegration = z.infer<typeof insertJiraIntegrationSchema>;
export type JiraIntegration = typeof jiraIntegrations.$inferSelect;

// User Story types
export const insertUserStorySchema = createInsertSchema(userStories);
export type InsertUserStory = z.infer<typeof insertUserStorySchema>;
export type UserStory = typeof userStories.$inferSelect;

// Story Estimation types
export const insertStoryEstimationSchema = createInsertSchema(storyEstimations);
export type InsertStoryEstimation = z.infer<typeof insertStoryEstimationSchema>;
export type StoryEstimation = typeof storyEstimations.$inferSelect;

// JIRA Sync Log types
export const insertJiraSyncLogSchema = createInsertSchema(jiraSyncLogs);
export type InsertJiraSyncLog = z.infer<typeof insertJiraSyncLogSchema>;
export type JiraSyncLog = typeof jiraSyncLogs.$inferSelect;

// Social Media tables
export const socialMediaAccounts = pgTable("social_media_accounts", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  platform: text("platform").notNull(), // "facebook", "instagram", "linkedin", "twitter", "mastodon"
  accountName: text("account_name").notNull(),
  accountId: text("account_id"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  profileUrl: text("profile_url"),
  profileImage: text("profile_image"),
  isActive: boolean("is_active").default(true),
  // Meta-specific fields for Instagram Business/Facebook Pages
  businessAccountId: text("business_account_id"), // Instagram Business Account ID
  pageId: text("page_id"), // Connected Facebook Page ID for Instagram
  accountType: text("account_type"), // "personal", "business", "creator", "page"
  permissions: text("permissions").array(), // granted permissions
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const socialMediaGoals = pgTable("social_media_goals", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  goalType: text("goal_type").notNull(), // "awareness", "engagement", "traffic", "conversion", "signups"
  targetMetric: text("target_metric"), // specific metric to track
  targetValue: integer("target_value"), // target number
  currentValue: integer("current_value").default(0),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const socialMediaBrandProfiles = pgTable("social_media_brand_profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  businessName: text("business_name").notNull(),
  businessDescription: text("business_description"),
  brandVoice: text("brand_voice"), // professional, casual, friendly, authoritative
  targetAudience: text("target_audience"),
  contentThemes: text("content_themes").array(), // array of themes
  keywords: text("keywords").array(), // SEO keywords
  primaryColor: text("primary_color"),
  secondaryColor: text("secondary_color"),
  logoUrl: text("logo_url"),
  websiteUrl: text("website_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const socialMediaPosts = pgTable("social_media_posts", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  goalId: integer("goal_id").references(() => socialMediaGoals.id),
  brandProfileId: integer("brand_profile_id").references(
    () => socialMediaBrandProfiles.id,
  ),
  content: text("content").notNull(),
  platforms: text("platforms").array().notNull(), // ["facebook", "instagram", "linkedin", "twitter"]
  platformContent: jsonb("platform_content"), // platform-specific variations
  hashtags: text("hashtags").array(),
  mediaUrls: text("media_urls").array(),
  mediaPrompt: text("media_prompt"), // AI image generation prompt
  callToAction: text("call_to_action"),
  status: text("status").default("draft"), // "draft", "scheduled", "published", "failed"
  scheduledAt: timestamp("scheduled_at"),
  publishedAt: timestamp("published_at"),
  aiGenerated: boolean("ai_generated").default(false),
  sourceContent: text("source_content"), // original content that was transformed
  sourceType: text("source_type"), // "blog", "link", "update", "prompt"
  // Instagram-specific fields
  instagramMediaType: text("instagram_media_type"), // "IMAGE", "VIDEO", "CAROUSEL_ALBUM"
  instagramLocation: jsonb("instagram_location"), // location data for Instagram posts
  // Meta publishing fields
  platformPostIds: jsonb("platform_post_ids"), // {"instagram": "post_id", "facebook": "page_post_id"}
  publishErrors: jsonb("publish_errors"), // platform-specific error details
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const socialMediaPostMetrics = pgTable("social_media_post_metrics", {
  id: serial("id").primaryKey(),
  postId: integer("post_id")
    .references(() => socialMediaPosts.id)
    .notNull(),
  platform: text("platform").notNull(),
  platformPostId: text("platform_post_id"),
  impressions: integer("impressions").default(0),
  reach: integer("reach").default(0),
  likes: integer("likes").default(0),
  comments: integer("comments").default(0),
  shares: integer("shares").default(0),
  clicks: integer("clicks").default(0),
  engagementRate: integer("engagement_rate"), // percentage * 100
  lastUpdated: timestamp("last_updated").defaultNow(),
});

export const socialMediaContentTemplates = pgTable(
  "social_media_content_templates",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    platform: text("platform"),
    templateType: text("template_type"), // "product_launch", "event", "blog_promotion", etc.
    contentPattern: text("content_pattern").notNull(),
    variables: text("variables").array(), // placeholders in the template
    hashtags: text("hashtags").array(),
    isPublic: boolean("is_public").default(false),
    createdAt: timestamp("created_at").defaultNow(),
  },
);

// Scheduled Social Media Posts schema - for cron job management
export const scheduledSocialPosts = pgTable("scheduled_social_posts", {
  id: text("id").primaryKey(), // Using string ID for compatibility with existing frontend
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  topic: text("topic").notNull(),
  tone: text("tone"),
  platform: text("platform").notNull(), // "mastodon", "linkedin", "twitter"
  scheduledTime: timestamp("scheduled_time").notNull(),
  userTimezone: text("user_timezone").default("UTC"),
  status: text("status").default("scheduled"), // "scheduled", "executing", "completed", "failed", "cancelled"
  mediaUrls: text("media_urls").array().default([]), // Array of media file URLs
  preGeneratedContent: text("pre_generated_content"), // User edited content preview
  credentials: jsonb("credentials"), // Platform credentials (access tokens etc)
  executedAt: timestamp("executed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Completed Social Media Posts schema - for job history
export const completedSocialPosts = pgTable("completed_social_posts", {
  id: text("id").primaryKey(), // Using string ID for compatibility with existing frontend
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  topic: text("topic").notNull(),
  tone: text("tone"),
  platform: text("platform").notNull(),
  scheduledTime: timestamp("scheduled_time").notNull(),
  executedAt: timestamp("executed_at").notNull(),
  status: text("status").notNull(), // "completed", "failed"
  finalContent: text("final_content"), // The actual content that was published
  mediaUrls: text("media_urls").array().default([]),
  errorMessage: text("error_message"),
  platformResponse: jsonb("platform_response"), // Response from social media platform
  userTimezone: text("user_timezone").default("UTC"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Social Media types
export const insertSocialMediaAccountSchema =
  createInsertSchema(socialMediaAccounts);
export type InsertSocialMediaAccount = z.infer<
  typeof insertSocialMediaAccountSchema
>;
export type SocialMediaAccount = typeof socialMediaAccounts.$inferSelect;

export const insertSocialMediaGoalSchema = createInsertSchema(socialMediaGoals);
export type InsertSocialMediaGoal = z.infer<typeof insertSocialMediaGoalSchema>;
export type SocialMediaGoal = typeof socialMediaGoals.$inferSelect;
export type SelectSocialMediaGoal = typeof socialMediaGoals.$inferSelect;

export const insertSocialMediaBrandProfileSchema = createInsertSchema(
  socialMediaBrandProfiles,
);
export type InsertSocialMediaBrandProfile = z.infer<
  typeof insertSocialMediaBrandProfileSchema
>;
export type SocialMediaBrandProfile =
  typeof socialMediaBrandProfiles.$inferSelect;
export type SelectSocialMediaBrandProfile =
  typeof socialMediaBrandProfiles.$inferSelect;

export const insertSocialMediaPostSchema = createInsertSchema(socialMediaPosts);
export type InsertSocialMediaPost = z.infer<typeof insertSocialMediaPostSchema>;
export type SocialMediaPost = typeof socialMediaPosts.$inferSelect;
export type SelectSocialMediaPost = typeof socialMediaPosts.$inferSelect;

// Scheduled Social Media Posts types
export const insertScheduledSocialPostSchema =
  createInsertSchema(scheduledSocialPosts);
export type InsertScheduledSocialPost = z.infer<
  typeof insertScheduledSocialPostSchema
>;
export type ScheduledSocialPost = typeof scheduledSocialPosts.$inferSelect;

// Completed Social Media Posts types
export const insertCompletedSocialPostSchema =
  createInsertSchema(completedSocialPosts);
export type InsertCompletedSocialPost = z.infer<
  typeof insertCompletedSocialPostSchema
>;
export type CompletedSocialPost = typeof completedSocialPosts.$inferSelect;

export const insertSocialMediaPostMetricsSchema = createInsertSchema(
  socialMediaPostMetrics,
);
export type InsertSocialMediaPostMetrics = z.infer<
  typeof insertSocialMediaPostMetricsSchema
>;
export type SocialMediaPostMetrics = typeof socialMediaPostMetrics.$inferSelect;

export const insertSocialMediaContentTemplateSchema = createInsertSchema(
  socialMediaContentTemplates,
);
export type InsertSocialMediaContentTemplate = z.infer<
  typeof insertSocialMediaContentTemplateSchema
>;
export type SocialMediaContentTemplate =
  typeof socialMediaContentTemplates.$inferSelect;

// AI Agents types
export const insertAiAgentSchema = createInsertSchema(aiAgents);
export type InsertAiAgent = z.infer<typeof insertAiAgentSchema>;
export type AiAgent = typeof aiAgents.$inferSelect;

// Subscription schemas and types
export const insertSubscriptionPlanSchema = createInsertSchema(
  subscriptionPlans,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubscriptionPlan = z.infer<
  typeof insertSubscriptionPlanSchema
>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;

export const insertFeatureSchema = createInsertSchema(features).omit({
  id: true,
  createdAt: true,
});
export type InsertFeature = z.infer<typeof insertFeatureSchema>;
export type Feature = typeof features.$inferSelect;

// Note: TaskPriorityScore and PriorityWeightingPreference types are already defined above

// Forms schema for event inquiry forms and other form builders
export const forms = pgTable("forms", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  createdBy: varchar("created_by")
    .notNull()
    .references(() => users.id),
  shareToken: text("share_token").notNull().unique(), // unique token for sharing
  isPublic: boolean("is_public").default(true),
  isActive: boolean("is_active").default(true),
  fields: jsonb("fields").notNull(), // array of form field definitions
  settings: jsonb("settings").default({}), // form settings like branding, redirects, etc.
  responseCount: integer("response_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Form Submissions schema for storing form responses
export const formSubmissions = pgTable("form_submissions", {
  id: serial("id").primaryKey(),
  formId: integer("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  responseData: jsonb("response_data").notNull(), // submitted field values
  submitterEmail: text("submitter_email"), // optional email if provided
  submitterName: text("submitter_name"), // optional name if provided
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Forms types
export const insertFormSchema = createInsertSchema(forms).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  responseCount: true,
});
export type InsertForm = z.infer<typeof insertFormSchema>;
export type Form = typeof forms.$inferSelect;

export const insertFormSubmissionSchema = createInsertSchema(
  formSubmissions,
).omit({ id: true, createdAt: true });
export type InsertFormSubmission = z.infer<typeof insertFormSubmissionSchema>;
export type FormSubmission = typeof formSubmissions.$inferSelect;

// Password Reset Tokens types
export const insertPasswordResetTokenSchema = createInsertSchema(
  passwordResetTokens,
).omit({ id: true, createdAt: true });
export type InsertPasswordResetToken = z.infer<
  typeof insertPasswordResetTokenSchema
>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// Evidence Items schema - Evidence Library for discovery workflow
export const evidenceItems = pgTable("evidence_items", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("note"),
  sourceId: integer("source_id"),
  tags: text("tags").array().default([]),
  metadata: jsonb("metadata").default({}),
  insightType: text("insight_type"),
  mentionCount: integer("mention_count").default(1),
  objectPath: text("object_path"),
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertEvidenceItemSchema = createInsertSchema(evidenceItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEvidenceItem = z.infer<typeof insertEvidenceItemSchema>;
export type EvidenceItem = typeof evidenceItems.$inferSelect;

// Conversations / Meetings schema
export type ConversationActionItem = {
  id: string;
  text: string;
  owner?: string | null;
  dueHint?: string | null;
  routedProjectId?: number | null;
  routedProjectName?: string | null;
  routedTaskId?: number | null;
  routedAt?: string | null;
};

export type DiarizedUtterance = {
  speaker: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
};

export type SpeakerMapEntry = {
  name: string;
  confidence: number;
};
export type SpeakerMap = Record<string, SpeakerMapEntry>;

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  source: text("source").notNull().default("manual"),
  content: text("content").notNull(),
  summary: text("summary"),
  actionItems: jsonb("action_items").$type<ConversationActionItem[]>().default([]),
  participants: text("participants").array().default([]),
  meetingDate: timestamp("meeting_date"),
  tags: text("tags").array().default([]),
  channelName: text("channel_name"),
  threadId: text("thread_id"),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  audioUrl: text("audio_url"),
  audioMimeType: text("audio_mime_type"),
  diarizedTranscript: jsonb("diarized_transcript").$type<DiarizedUtterance[]>(),
  speakerMap: jsonb("speaker_map").$type<SpeakerMap>(),
  participantCount: integer("participant_count"),
  // External system identifier used for dedupe on import (e.g. Gmail message id "gmail:<id>").
  externalId: text("external_id"),
  // File attachments extracted from the source (e.g. Gmail attachments). Each entry stores
  // metadata + the object-storage path so we can stream the file back on demand.
  attachments: jsonb("attachments").$type<ConversationAttachment[]>().default([]),
  // Source-specific structured headers (Gmail: from/to/cc/subject/date/messageId/threadId/labels;
  // Slack: channel/user/ts; etc.). Read by Context Brain + UI badges.
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ConversationAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  // Normalized "/media/<id>" path returned by ObjectStorageService.uploadMediaBuffer.
  // Optional because tiny attachments may be skipped, in which case only metadata is kept.
  objectPath?: string;
};

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;

// Per-attachment row keyed by its own id (preferred over index-based addressing
// in conversations.attachments JSON). New code should write here; the JSON
// column is kept for backwards-compat with previously imported emails.
export const conversationAttachments = pgTable("conversation_attachments", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  // "/media/<id>" object-storage path; null when the file exceeded the size cap
  // and only metadata was persisted.
  objectPath: text("object_path"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertConversationAttachmentSchema = createInsertSchema(
  conversationAttachments,
).omit({ id: true, createdAt: true });
export type InsertConversationAttachment = z.infer<
  typeof insertConversationAttachmentSchema
>;
export type ConversationAttachmentRow =
  typeof conversationAttachments.$inferSelect;

// Persistent per-user voice "registry". Each row represents one recurring
// speaker (e.g. a teammate) whose speaking style has been learned across
// meetings. The embedding is an L2-normalized vector — see
// server/services/voiceprints.ts for the extractor used to fill it in.
export const speakerVoiceprints = pgTable("speaker_voiceprints", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  canonicalName: text("canonical_name").notNull(),
  teamMemberId: integer("team_member_id").references(() => teamMembers.id, {
    onDelete: "set null",
  }),
  embedding: jsonb("embedding").$type<number[]>().notNull(),
  sampleCount: integer("sample_count").notNull().default(1),
  meetingCount: integer("meeting_count").notNull().default(0),
  totalTalkTimeMs: integer("total_talk_time_ms").notNull().default(0),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSpeakerVoiceprintSchema = createInsertSchema(
  speakerVoiceprints,
).omit({ id: true, createdAt: true, updatedAt: true, lastSeenAt: true });
export type InsertSpeakerVoiceprint = z.infer<
  typeof insertSpeakerVoiceprintSchema
>;
export type SpeakerVoiceprint = typeof speakerVoiceprints.$inferSelect;

// Teams Meetings
export const teamsMeetings = pgTable("teams_meetings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  joinUrl: text("join_url"),
  meetingId: text("meeting_id"),
  threadId: text("thread_id"),
  status: text("status").notNull().default("scheduled"),
  transcript: text("transcript"),
  projectPlan: jsonb("project_plan"),
  attendees: text("attendees").array().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTeamsMeetingSchema = createInsertSchema(teamsMeetings).omit({
  id: true,
  createdAt: true,
});
export type InsertTeamsMeeting = z.infer<typeof insertTeamsMeetingSchema>;
export type TeamsMeeting = typeof teamsMeetings.$inferSelect;

export const googleMeetMeetings = pgTable("google_meet_meetings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  meetLink: text("meet_link"),
  calendarEventId: text("calendar_event_id"),
  organizerEmail: text("organizer_email"),
  status: text("status").notNull().default("scheduled"),
  transcript: text("transcript"),
  recordingUrl: text("recording_url"),
  attendees: text("attendees").array().default([]),
  meetingCode: text("meeting_code"),
  transcriptDocId: text("transcript_doc_id"),
  conferenceRecordId: text("conference_record_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGoogleMeetMeetingSchema = createInsertSchema(googleMeetMeetings).omit({
  id: true,
  createdAt: true,
});
export type InsertGoogleMeetMeeting = z.infer<typeof insertGoogleMeetMeetingSchema>;
export type GoogleMeetMeeting = typeof googleMeetMeetings.$inferSelect;

export const zoomMeetings = pgTable("zoom_meetings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  duration: integer("duration"),
  joinUrl: text("join_url"),
  startUrl: text("start_url"),
  zoomMeetingId: text("zoom_meeting_id"),
  status: text("status").notNull().default("scheduled"),
  transcript: text("transcript"),
  recordingUrl: text("recording_url"),
  attendees: text("attendees").array().default([]),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertZoomMeetingSchema = createInsertSchema(zoomMeetings).omit({
  id: true,
  createdAt: true,
});
export type InsertZoomMeeting = z.infer<typeof insertZoomMeetingSchema>;
export type ZoomMeeting = typeof zoomMeetings.$inferSelect;

// Raw Inputs (Meeting notes, conversation imports)
export const rawInputs = pgTable("raw_inputs", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("manual"),
  sourceType: text("source_type").notNull().default("notes"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRawInputSchema = createInsertSchema(rawInputs).omit({
  id: true,
  createdAt: true,
});
export type InsertRawInput = z.infer<typeof insertRawInputSchema>;
export type RawInput = typeof rawInputs.$inferSelect;

export const discoveryReports = pgTable("discovery_reports", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id),
  shareToken: text("share_token").notNull().unique(),
  title: text("title").notNull(),
  reportData: jsonb("report_data").notNull(),
  isPublic: boolean("is_public").default(true),
  viewCount: integer("view_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDiscoveryReportSchema = createInsertSchema(
  discoveryReports,
).omit({
  id: true,
  createdAt: true,
  viewCount: true,
});
export type InsertDiscoveryReport = z.infer<typeof insertDiscoveryReportSchema>;
export type DiscoveryReport = typeof discoveryReports.$inferSelect;

export const tokenUsage = pgTable("token_usage", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCost: text("estimated_cost").notNull().default("0"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTokenUsageSchema = createInsertSchema(tokenUsage).omit({
  id: true,
  createdAt: true,
});
export type InsertTokenUsage = z.infer<typeof insertTokenUsageSchema>;
export type TokenUsage = typeof tokenUsage.$inferSelect;

export const tokenBudgets = pgTable("token_budgets", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  monthlyLimit: integer("monthly_limit").notNull().default(1000000),
  tokensUsedThisMonth: integer("tokens_used_this_month").notNull().default(0),
  resetDate: timestamp("reset_date").notNull(),
  lastWarningAt: timestamp("last_warning_at"),
  degradedMode: boolean("degraded_mode").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTokenBudgetSchema = createInsertSchema(tokenBudgets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTokenBudget = z.infer<typeof insertTokenBudgetSchema>;
export type TokenBudget = typeof tokenBudgets.$inferSelect;

// =============================================================================
// RAG Foundation (Task #92): embeddings + AI response feedback
// -----------------------------------------------------------------------------
// `embeddings` is the unified vector store for retrieval. One row = one chunk
// of one source object (evidence item, conversation, diarized utterance,
// feature candidate, insight). We dedupe by the natural key
// (source_type, source_id, chunk_index) — see the unique index in db-setup.ts.
// `status` lets the worker remember failures so the next pass doesn't retry
// hopeless inputs (e.g. binary blobs); the worker treats only `pending` as
// retry-eligible and stores `ok` rows with the actual vector.
// =============================================================================
export const embeddings = pgTable("embeddings", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(), // 'evidence'|'conversation'|'utterance'|'feature_candidate'|'insight'
  sourceId: integer("source_id").notNull(),
  chunkIndex: integer("chunk_index").notNull().default(0),
  content: text("content").notNull(),
  embedding: vector("embedding"),
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  status: text("status").notNull().default("ok"), // 'ok'|'skipped'|'failed'
  errorReason: text("error_reason"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertEmbeddingSchema = createInsertSchema(embeddings).omit({
  id: true,
  createdAt: true,
});
export type InsertEmbedding = z.infer<typeof insertEmbeddingSchema>;
export type Embedding = typeof embeddings.$inferSelect;

// `ai_response_feedback` is the thumbs-up/down telemetry table. We persist
// `retrievedChunkIds` from day one even though Task #92 always passes `[]` —
// Task #93 (Hybrid Retrieval) will populate it without a schema change.
export const aiResponseFeedback = pgTable("ai_response_feedback", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  sessionId: text("session_id"),
  surface: text("surface").notNull(), // 'brain'|'planner'|'build'|'other'
  query: text("query"),
  responseText: text("response_text"),
  modelUsed: text("model_used"),
  retrievedChunkIds: integer("retrieved_chunk_ids").array().default([]),
  // Task #94 — citation telemetry. `citationsEmitted` is the count the
  // server validated and shipped to the client; `citationsStripped` is the
  // count the faithfulness verifier rejected; `citationsClicked` is
  // bumped by POST /api/ai/citation-click as the user opens sources.
  citationsEmitted: integer("citations_emitted").default(0),
  citationsStripped: integer("citations_stripped").default(0),
  citationsClicked: integer("citations_clicked").default(0),
  // Task #98 — entity-graph telemetry. `entitiesExtracted`/`edgesExtracted`
  // come from per-chunk extraction summed across the question's retrieved
  // set; `neighborsAdded` is the count of 1-hop neighbor chunks the
  // retriever merged in on top of the lexical/vector top-K.
  entitiesExtracted: integer("entities_extracted").default(0),
  edgesExtracted: integer("edges_extracted").default(0),
  neighborsAdded: integer("neighbors_added").default(0),
  // Task #104 — response quality scores (0..1). Computed by the fail-open
  // post-response quality checker (format match / specificity / completeness)
  // at answer time and passed through the feedback POST. Null when the checker
  // is disabled or errored. Short per-axis reasons live in `metadata.quality`.
  qualityFormat: real("quality_format"),
  qualitySpecificity: real("quality_specificity"),
  qualityCompleteness: real("quality_completeness"),
  rating: integer("rating").notNull(), // 1 = up, -1 = down
  comment: text("comment"),
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAiResponseFeedbackSchema = createInsertSchema(
  aiResponseFeedback,
).omit({ id: true, createdAt: true });
export type InsertAiResponseFeedback = z.infer<
  typeof insertAiResponseFeedbackSchema
>;
export type AiResponseFeedback = typeof aiResponseFeedback.$inferSelect;

// =============================================================================
// Task #105 — RAG eval harness results
// -----------------------------------------------------------------------------
// One row per harness run. `config` snapshots the retrieval config in effect at
// run time (k, reranker key present, faithfulness mode, whether answers were
// generated) so two runs can be diffed apples-to-apples. Aggregate metrics are
// stored as their own columns for cheap sorting/diffing; `results` holds the
// full per-case outcome array for drill-down. Writes are append-only; the
// harness never mutates user data (entities/beliefs/embeddings).
// =============================================================================
export const ragEvalRuns = pgTable("rag_eval_runs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  // Snapshot of the config in effect: { k, rerankerKeyPresent,
  // faithfulnessMode, openaiKeyPresent, generateAnswers, answerModel }.
  config: jsonb("config").$type<Record<string, any>>().default({}),
  caseCount: integer("case_count").notNull().default(0),
  passCount: integer("pass_count").notNull().default(0),
  // Aggregate metrics (0..1). faithfulnessPassRate is null when no answers
  // were generated (e.g. OPENAI_API_KEY missing or --no-answers).
  recallAtK: real("recall_at_k"),
  faithfulnessPassRate: real("faithfulness_pass_rate"),
  groundingRate: real("grounding_rate"),
  fallbackRate: real("fallback_rate"),
  // Full per-case outcomes (EvalCaseResult[]).
  results: jsonb("results").$type<any[]>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertRagEvalRunSchema = createInsertSchema(ragEvalRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertRagEvalRun = z.infer<typeof insertRagEvalRunSchema>;
export type RagEvalRun = typeof ragEvalRuns.$inferSelect;

// =============================================================================
// Task #98 — Entity Graph over embeddings
// -----------------------------------------------------------------------------
// `entities` is a tiny per-user typed dictionary of nouns we've seen in any
// embedded chunk (people, companies, projects, features, risks, decisions,
// tools, topics). `entity_edges` are typed directed links between two
// entities, anchored to the embedding chunk that gave us the evidence. The
// retriever walks 1-hop neighbors of entities mentioned in the top-K chunks
// to merge in "related" chunks the lexical/vector layer couldn't find.
//
// `entity_extraction_cache` keys gpt-4o-mini's extraction output by
// sha256(chunkText) so re-embeds / repeated text don't re-spend tokens.
// Extraction is content-addressable (no PII baked into the cache key) and
// per-chunk fan-out into entities/edges is still strictly userId-scoped.
// =============================================================================
export const entities = pgTable(
  "entities",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    kind: text("kind").notNull(), // 'person'|'company'|'project'|'feature'|'risk'|'decision'|'tool'|'topic'
    slug: text("slug").notNull(), // normalized: lowercase-kebab
    displayName: text("display_name").notNull(),
    mentionCount: integer("mention_count").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    unique("entities_user_kind_slug").on(table.userId, table.kind, table.slug),
    index("entities_user_kind_idx").on(table.userId, table.kind),
  ],
);

export const insertEntitySchema = createInsertSchema(entities).omit({
  id: true,
  createdAt: true,
});
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type Entity = typeof entities.$inferSelect;

export const entityEdges = pgTable(
  "entity_edges",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    srcEntityId: integer("src_entity_id").notNull(),
    dstEntityId: integer("dst_entity_id").notNull(),
    predicate: text("predicate").notNull(), // mentions|works_at|blocks|owns|attended|decided|assigned_to|said
    sourceEmbeddingId: integer("source_embedding_id").notNull(),
    confidence: integer("confidence").notNull().default(70), // 0–100
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("entity_edges_user_src_pred_idx").on(
      table.userId,
      table.srcEntityId,
      table.predicate,
    ),
    index("entity_edges_user_dst_pred_idx").on(
      table.userId,
      table.dstEntityId,
      table.predicate,
    ),
    index("entity_edges_user_chunk_idx").on(
      table.userId,
      table.sourceEmbeddingId,
    ),
    unique("entity_edges_natural_key").on(
      table.userId,
      table.srcEntityId,
      table.dstEntityId,
      table.predicate,
      table.sourceEmbeddingId,
    ),
  ],
);

export const insertEntityEdgeSchema = createInsertSchema(entityEdges).omit({
  id: true,
  createdAt: true,
});
export type InsertEntityEdge = z.infer<typeof insertEntityEdgeSchema>;
export type EntityEdge = typeof entityEdges.$inferSelect;

export const entityExtractionCache = pgTable("entity_extraction_cache", {
  chunkHash: varchar("chunk_hash", { length: 64 }).primaryKey(),
  result: jsonb("result").notNull(), // {entities: [...], edges: [...]}
  modelUsed: text("model_used").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type EntityExtractionCache =
  typeof entityExtractionCache.$inferSelect;

// =============================================================================
// Task #99 — Durable Beliefs (consolidation of repeated mentions).
// -----------------------------------------------------------------------------
// A `belief` is a single canonical claim about a subject entity that has been
// observed across ≥3 source chunks. The nightly consolidator (run by
// `server/services/cron-scheduler.ts`) groups recent entity edges by
// (subjectEntityId, predicate), asks gpt-4o-mini to mint a canonical
// {predicate, object, weight, holder} claim, and either upserts or marks as
// contradiction. Untouched beliefs decay to `stale` after 30 days.
//
// The retriever (`server/services/retrieval.ts`) treats beliefs as a first-
// class source type alongside raw chunks: vector search on the claim
// embedding, surfaced with `metadata.via = 'belief'` so the citation chip
// renders a single chip that fans out to the underlying source chunks.
// =============================================================================
export const beliefs = pgTable(
  "beliefs",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    // Subject is always an `entities.id` row; we don't FK at the Drizzle
    // level (entities are upserted by extractor, ordering not guaranteed)
    // but DB-side FK is added in db-setup.ts.
    subjectEntityId: integer("subject_entity_id").notNull(),
    predicate: text("predicate").notNull(), // 'worried_about'|'wants'|'blocked_by'|'owns'|'committed_to'|free-form
    object: text("object").notNull(),
    holder: text("holder"), // 'team'|'Naveen'|'CFO'|etc — who holds the claim
    weight: real("weight").notNull().default(0.5), // 0..1, set by LLM at extraction
    embedding: vector("embedding"), // embedded(predicate + " " + object)
    sourceEmbeddingIds: integer("source_embedding_ids").array().default([]),
    mentionCount: integer("mention_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at").defaultNow(),
    lastSeenAt: timestamp("last_seen_at").defaultNow(),
    decayedAt: timestamp("decayed_at"),
    contradictionOfBeliefId: integer("contradiction_of_belief_id"),
    status: text("status").notNull().default("active"), // 'active'|'stale'|'contradicted'
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("beliefs_user_subject_idx").on(table.userId, table.subjectEntityId),
    index("beliefs_user_status_idx").on(
      table.userId,
      table.status,
      table.lastSeenAt,
    ),
  ],
);

export const insertBeliefSchema = createInsertSchema(beliefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBelief = z.infer<typeof insertBeliefSchema>;
export type Belief = typeof beliefs.$inferSelect;

// ── Meeting Intelligence (bulk-transcript MOM processor) ──────────────
export const meetingIntelligenceBatches = pgTable(
  "meeting_intelligence_batches",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label"),
    /** queued | running | completed | failed. */
    status: text("status").notNull().default("queued"),
    totalCount: integer("total_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    metadata: jsonb("metadata"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export const meetingIntelligenceDocuments = pgTable(
  "meeting_intelligence_documents",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Nullable; bulk-enqueued documents are grouped under a single batch row. */
    batchId: integer("batch_id"),
    transcriptId: text("transcript_id").notNull(),
    projectName: text("project_name"),
    department: text("department"),
    meetingSource: text("meeting_source").notNull(), // Zoom | Teams | Google Meet | Slack | Discord | Email | Audio/Video | PDF/DOCX/TXT | Other
    meetingDate: text("meeting_date"), // YYYY-MM-DD; kept as text to preserve raw input
    meetingTitle: text("meeting_title"),
    participants: text("participants").array().notNull().default([]),
    transcriptText: text("transcript_text").notNull(),
    documentJson: jsonb("document_json"), // structured extraction
    documentMarkdown: text("document_markdown"), // rendered MOM
    confidenceScore: real("confidence_score"),
    /** queued (awaiting worker) | processing | completed | failed. */
    status: text("status").notNull().default("processing"),
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").notNull().default(1), // how many chunks the transcript was split into
    tokenUsage: jsonb("token_usage"), // { inputTokens, outputTokens, totalTokens, model }
    /** ISO timestamp when the worker claimed this row; used by the stuck-claim reaper. */
    claimedAt: timestamp("claimed_at"),
    /** Number of times processing has been attempted. */
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export const insertMeetingIntelligenceBatchSchema = createInsertSchema(
  meetingIntelligenceBatches,
).omit({ id: true, createdAt: true, updatedAt: true, completedAt: true });
export type InsertMeetingIntelligenceBatch = z.infer<
  typeof insertMeetingIntelligenceBatchSchema
>;
export type MeetingIntelligenceBatch =
  typeof meetingIntelligenceBatches.$inferSelect;

export const insertMeetingIntelligenceDocumentSchema = createInsertSchema(
  meetingIntelligenceDocuments,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMeetingIntelligenceDocument = z.infer<
  typeof insertMeetingIntelligenceDocumentSchema
>;
export type MeetingIntelligenceDocument =
  typeof meetingIntelligenceDocuments.$inferSelect;
