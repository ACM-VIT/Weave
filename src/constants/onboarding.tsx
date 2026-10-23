import React from "react";
import { ONBOARDING_SKILLS, ONBOARDING_INTERESTS } from "../../backend/contracts/onboardingTaxonomy";
import FrontendSVG from "@/assets/images/onboarding/frontend.svg";
import BackendSVG from "@/assets/images/onboarding/backend.svg";
import AiMlSVG from "@/assets/images/onboarding/ai_ml.svg";
import DevopsSVG from "@/assets/images/onboarding/devops.svg";
import DatabaseSVG from "@/assets/images/onboarding/database.svg";
import MobileSVG from "@/assets/images/onboarding/mobile.svg";
import SystemsSVG from "@/assets/images/onboarding/systems.svg";

import ReactSVG from "@/assets/images/onboarding/react.svg";
import TypeScriptSVG from "@/assets/images/onboarding/typescript.svg";
import JavaScriptSVG from "@/assets/images/onboarding/javascript.svg";
import PythonSVG from "@/assets/images/onboarding/python.svg";
import JavaSVG from "@/assets/images/onboarding/java.svg";
import NodeJsSVG from "@/assets/images/onboarding/node_js.svg";
import ExpressSVG from "@/assets/images/onboarding/express.svg";
import DjangoSVG from "@/assets/images/onboarding/django.svg";
import FlaskSVG from "@/assets/images/onboarding/flask.svg";
import DockerSVG from "@/assets/images/onboarding/docker.svg";
import KubernetesSVG from "@/assets/images/onboarding/kubernetes.svg";
import GitSVG from "@/assets/images/onboarding/git.svg";
import GitHubSVG from "@/assets/images/onboarding/github.svg";
import FirebaseSVG from "@/assets/images/onboarding/firebase.svg";
import MongoDBSVG from "@/assets/images/onboarding/mongodb.svg";
import PostgreSQLSVG from "@/assets/images/onboarding/postgresql.svg";
import AWSSVG from "@/assets/images/onboarding/aws.svg";
import TailwindCssSVG from "@/assets/images/onboarding/tailwind_css.svg";
import DefaultTechSVG from "@/assets/images/onboarding/default_tech.svg";

export interface SkillCategory {
  id: string;
  title: string;
  icon: React.JSX.Element;
  order: number;
}

export interface TechStack {
  id: string;
  name: string;
  icon: React.JSX.Element;
}

export interface Interest {
  id: string;
  name: string;
  icon: React.JSX.Element;
}

export interface InterestCategory {
  id: string;
  title: string;
  interests: Interest[];
}

export const getTechIcon = (name: string): React.JSX.Element => {
  const n = name.toLowerCase();
  if (n.includes('react')) return <ReactSVG width={16} height={16} />;
  if (n.includes('typescript') || n === 'ts') return <TypeScriptSVG width={16} height={16} />;
  if (n.includes('javascript') || n === 'js') return <JavaScriptSVG width={16} height={16} />;
  if (n.includes('python')) return <PythonSVG width={16} height={16} />;
  if (n.includes('java') && !n.includes('script')) return <JavaSVG width={16} height={16} />;
  if (n.includes('node')) return <NodeJsSVG width={16} height={16} />;
  if (n.includes('express')) return <ExpressSVG width={16} height={16} />;
  if (n.includes('django')) return <DjangoSVG width={16} height={16} />;
  if (n.includes('flask')) return <FlaskSVG width={16} height={16} />;
  if (n.includes('docker')) return <DockerSVG width={16} height={16} />;
  if (n.includes('kubernetes') || n === 'k8s') return <KubernetesSVG width={16} height={16} />;
  if (n === 'git') return <GitSVG width={16} height={16} />;
  if (n.includes('github')) return <GitHubSVG width={16} height={16} />;
  if (n.includes('firebase')) return <FirebaseSVG width={16} height={16} />;
  if (n.includes('mongo')) return <MongoDBSVG width={16} height={16} />;
  if (n.includes('postgres')) return <PostgreSQLSVG width={16} height={16} />;
  if (n.includes('aws')) return <AWSSVG width={16} height={16} />;
  if (n.includes('tailwind')) return <TailwindCssSVG width={16} height={16} />;
  return <DefaultTechSVG width={16} height={16} />;
};

const SKILL_ICONS = [FrontendSVG, BackendSVG, AiMlSVG, DevopsSVG, DatabaseSVG, MobileSVG, SystemsSVG];
export const SKILL_CATEGORIES: SkillCategory[] = ONBOARDING_SKILLS.map((category, index) => {
  const Icon = SKILL_ICONS[index];
  return { ...category, order: index + 1, icon: <Icon width={24} height={24} /> };
});

export const SUGGESTED_TECHS: TechStack[] = [
  "React",
  "MongoDB",
  "Node.js",
  "Tailwind CSS",
  "PostgreSQL",
  "Next.js",
  "TypeScript",
  "GraphQL",
  "Docker",
  "Prisma",
  "AWS",
].map(name => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, icon: getTechIcon(name) }));

export const INTEREST_CATEGORIES: InterestCategory[] = SKILL_CATEGORIES.map(category => ({
  id: category.id,
  title: category.title,
  interests: (ONBOARDING_INTERESTS.find(entry => entry.id === category.id)?.interests ?? [])
    .map(interest => ({ ...interest, icon: getTechIcon(interest.name) })),
}));
